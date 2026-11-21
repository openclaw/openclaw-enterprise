// Command trace associates the command tree from "gog schema --include-hidden"
// with the Go methods and resource constructors reachable from each Kong Run method.
// Inputs are the release build's exported go list JSON and its CLI schema JSON.
package main

import (
	"encoding/json"
	"fmt"
	"go/ast"
	"go/importer"
	"go/parser"
	"go/token"
	"go/types"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
)

const module = "github.com/openclaw/gogcli/"
const sdk = "google.golang.org/api/"

type buildPackage struct {
	ImportPath, Dir, Export string
	GoFiles                 []string
}

type command struct {
	Name        string
	Subcommands []command
}

type graph map[string][]string

func checked(err error) {
	if err != nil {
		panic(err)
	}
}

func typeName(t types.Type) string {
	if pointer, ok := t.(*types.Pointer); ok {
		t = pointer.Elem()
	}
	if named, ok := types.Unalias(t).(*types.Named); ok {
		return named.Obj().Name()
	}
	return ""
}

// Use package-qualified names because each package is type-checked in isolation.
func symbol(object types.Object) string {
	if object == nil || object.Pkg() == nil {
		return ""
	}
	switch value := object.(type) {
	case *types.Func:
		fn := value.Origin()
		if receiver := fn.Signature().Recv(); receiver != nil {
			return fn.Pkg().Path() + " " + typeName(receiver.Type()) + "." + fn.Name()
		}
	case *types.Var:
		if value.Parent() != value.Pkg().Scope() {
			return ""
		}
	default:
		return ""
	}
	return object.Pkg().Path() + " " + object.Name()
}

func callbackKey(field *types.Var, owner string) string {
	return field.Pkg().Path() + " " + owner + "#" + field.Name()
}

func callbackField(info *types.Info, expr ast.Expr) *types.Var {
	id, ok := expr.(*ast.Ident)
	if !ok {
		return nil
	}
	field, ok := info.Uses[id].(*types.Var)
	if !ok || !field.IsField() || field.Pkg().Path() != module+"internal/app" {
		return nil
	}
	if _, ok := field.Type().Underlying().(*types.Signature); ok {
		return field
	}
	return nil
}

// The app.Runtime initializer installs all service callbacks, including Drive
// downloads. Following their assignments as calls would grant even "version"
// the Drive operations. Connect those callbacks only at a use of their field.
func (g graph) references(info *types.Info, body ast.Node) []string {
	var dependencies []string
	ast.Inspect(body, func(n ast.Node) bool {
		switch node := n.(type) {
		case *ast.CompositeLit:
			for _, item := range node.Elts {
				if kv, ok := item.(*ast.KeyValueExpr); ok {
					if field := callbackField(info, kv.Key); field != nil {
						key := callbackKey(field, typeName(info.TypeOf(node)))
						g[key] = append(g[key], g.references(info, kv.Value)...)
					}
				}
			}
		case *ast.KeyValueExpr:
			return callbackField(info, node.Key) == nil
		case *ast.CallExpr:
			if selector, ok := node.Fun.(*ast.SelectorExpr); ok {
				if selection := info.Selections[selector]; selection != nil && selection.Kind() == types.FieldVal {
					field := selection.Obj().(*types.Var)
					if field.Pkg() != nil {
						dependencies = append(dependencies, callbackKey(field, typeName(selection.Recv())))
					}
				}
			}
		case *ast.Ident:
			if name := symbol(info.Uses[node]); name != "" {
				dependencies = append(dependencies, name)
			}
		}
		return true
	})
	slices.Sort(dependencies)
	return slices.Compact(dependencies)
}

func collectTypes(pkg *types.Package) []*types.Named {
	var result []*types.Named
	for _, name := range pkg.Scope().Names() {
		if obj, ok := pkg.Scope().Lookup(name).(*types.TypeName); ok {
			if named, ok := obj.Type().(*types.Named); ok {
				result = append(result, named)
			}
		}
	}
	return result
}

func (g graph) readPackage(input buildPackage, fs *token.FileSet, importer types.Importer) *types.Package {
	info := &types.Info{
		Defs: map[*ast.Ident]types.Object{}, Uses: map[*ast.Ident]types.Object{},
		Selections: map[*ast.SelectorExpr]*types.Selection{}, Types: map[ast.Expr]types.TypeAndValue{},
	}
	var files []*ast.File
	for _, name := range input.GoFiles {
		f, err := parser.ParseFile(fs, filepath.Join(input.Dir, name), nil, parser.SkipObjectResolution)
		checked(err)
		files = append(files, f)
	}
	config := types.Config{Importer: importer, Sizes: types.SizesFor("gc", "amd64")}
	pkg, err := config.Check(input.ImportPath, fs, files, info)
	checked(err)
	for _, file := range files {
		for _, declaration := range file.Decls {
			switch decl := declaration.(type) {
			case *ast.FuncDecl:
				if decl.Body != nil {
					g[symbol(info.Defs[decl.Name])] = g.references(info, decl.Body)
				}
			case *ast.GenDecl:
				if decl.Tok == token.VAR {
					for _, s := range decl.Specs {
						spec := s.(*ast.ValueSpec)
						for _, name := range spec.Names {
							g[symbol(info.Defs[name])] = g.references(info, spec)
						}
					}
				}
			}
		}
	}
	return pkg
}

func (g graph) linkInterfaces(namedTypes []*types.Named) {
	for _, named := range namedTypes {
		iface, ok := named.Underlying().(*types.Interface)
		if !ok || iface.NumMethods() == 0 {
			continue
		}
		for _, candidate := range namedTypes {
			if _, ok := candidate.Underlying().(*types.Struct); !ok {
				continue
			}
			ptr := types.NewPointer(candidate)
			if !types.Implements(ptr, iface) {
				continue
			}
			for m := range iface.NumMethods() {
				method := iface.Method(m)
				target, _, _ := types.LookupFieldOrMethod(ptr, true, method.Pkg(), method.Name())
				if target != nil && symbol(method) != symbol(target) {
					key := symbol(method)
					g[key] = append(g[key], symbol(target))
				}
			}
		}
	}
}

// Record transport requirements separately from the JSON API method itself.
func additionalTransport(symbol string) string {
	switch {
	case strings.HasPrefix(symbol, sdk) && (strings.HasSuffix(symbol, "Call.Media") || strings.HasSuffix(symbol, "Call.ResumableMedia")):
		return "binary_media_upload"
	case symbol == module+"internal/cmd runDocsTabExport":
		return "docs_web_export"
	case symbol == module+"internal/cmd readPublicImageAspectRatio", symbol == module+"internal/cmd downloadSlidesThumbnail":
		return "external_image_url"
	case strings.HasPrefix(symbol, "cloud.google.com/go/pubsub/v2 "):
		return "pubsub_grpc"
	}
	return ""
}

type mappedCommand struct {
	Methods    []string `json:"methods"`
	Additional []string `json:"additional,omitempty"`
}

func (g graph) reachable(root string) mappedCommand {
	if _, ok := g[root]; !ok {
		panic("missing command entry point: " + root)
	}
	visited := map[string]bool{}
	stack := []string{root}
	var result mappedCommand
	for len(stack) > 0 {
		key := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if visited[key] {
			continue
		}
		visited[key] = true
		if t := additionalTransport(key); t != "" {
			result.Additional = append(result.Additional, t)
		}
		switch {
		case strings.HasPrefix(key, sdk) && strings.Contains(key, "Service."):
			result.Methods = append(result.Methods, strings.TrimPrefix(key, sdk))
		case strings.HasPrefix(key, module):
			stack = append(stack, g[key]...)
		}
	}
	slices.Sort(result.Methods)
	slices.Sort(result.Additional)
	result.Additional = slices.Compact(result.Additional)
	return result
}

func normalize(name string) string {
	return strings.ToLower(strings.ReplaceAll(name, "-", ""))
}

func (g graph) walk(result map[string]mappedCommand, path string, n command, t types.Type, pkg *types.Package) {
	if len(n.Subcommands) == 0 {
		fn, _, _ := types.LookupFieldOrMethod(t, true, pkg, "Run")
		result[path] = g.reachable(symbol(fn))
		return
	}
	st := t.Underlying().(*types.Struct)
	fields := map[string]types.Type{}
	for i := range st.NumFields() {
		tag := reflect.StructTag(st.Tag(i))
		if _, ok := tag.Lookup("cmd"); ok {
			name := tag.Get("name")
			if name == "" {
				name = st.Field(i).Name()
			}
			fields[normalize(name)] = st.Field(i).Type()
		}
	}
	for _, child := range n.Subcommands {
		sub := strings.TrimSpace(path + " " + child.Name)
		typ := fields[normalize(child.Name)]
		if typ == nil {
			panic("no matching command struct for " + sub)
		}
		g.walk(result, sub, child, typ, pkg)
	}
}

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: trace <go list -deps -export -json output> <gog schema --include-hidden output>")
		os.Exit(2)
	}
	in, err := os.Open(os.Args[1])
	checked(err)
	defer in.Close()
	dec := json.NewDecoder(in)
	exports := map[string]string{}
	var inputs []buildPackage
	var sdkPackages []string
	for {
		var p buildPackage
		if err := dec.Decode(&p); err == io.EOF {
			break
		} else {
			checked(err)
		}
		exports[p.ImportPath] = p.Export
		if strings.HasPrefix(p.ImportPath, module+"internal/") {
			inputs = append(inputs, p)
		}
		if strings.HasPrefix(p.ImportPath, sdk) {
			sdkPackages = append(sdkPackages, strings.TrimPrefix(p.ImportPath, sdk))
		}
	}
	fs := token.NewFileSet()
	imp := importer.ForCompiler(fs, "gc", func(path string) (io.ReadCloser, error) { return os.Open(exports[path]) })
	g := graph{}
	var commands *types.Package
	var namedTypes []*types.Named
	for _, p := range inputs {
		pkg := g.readPackage(p, fs, imp)
		canonical, err := imp.Import(p.ImportPath)
		checked(err)
		// The first scope contains unexported local implementations. The exported
		// scope has the identities shared by consumers of other local packages.
		namedTypes = append(namedTypes, collectTypes(pkg)...)
		namedTypes = append(namedTypes, collectTypes(canonical)...)
		if p.ImportPath == module+"internal/cmd" {
			commands = pkg
		}
	}
	g.linkInterfaces(namedTypes)
	data, err := os.ReadFile(os.Args[2])
	checked(err)
	var root struct{ Command command }
	checked(json.Unmarshal(data, &root))
	result := map[string]mappedCommand{}
	g.walk(result, "", root.Command, commands.Scope().Lookup("CLI").Type(), commands)
	checked(json.NewEncoder(os.Stdout).Encode(map[string]any{"packages": sdkPackages, "commands": result}))
}
