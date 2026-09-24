package occdev

import (
	"crypto/sha256"
	"encoding/json/v2"
	"fmt"
	"os"
	"os/user"
	"path/filepath"
	"strings"
)

const ownershipLabel = "io.openclaw.development.owner"

// Claims outlive the CLI process and are shared by every state directory for
// this user. The directory flock serializes only changes to the claim registry.
type resourceClaims struct {
	root  string
	paths []string
	owner []byte
}

func claimsFor(s *developmentState) (*resourceClaims, error) {
	account, err := user.Current()
	if err != nil {
		return nil, err
	}
	home, err := filepath.EvalSymlinks(account.HomeDir)
	if err != nil {
		return nil, err
	}
	root := filepath.Join(home, ".openclaw-development-claims")
	if err := os.Mkdir(root, 0700); err != nil && !os.IsExist(err) {
		return nil, err
	}
	if err := privateOwned(root, true); err != nil {
		return nil, err
	}
	endpoint := strings.TrimPrefix(s.DockerHost, "unix://")
	owner, err := json.Marshal(struct {
		ID             string `json:"id"`
		Directory      string `json:"directory"`
		DockerHost     string `json:"dockerHost"`
		ComposeProject string `json:"composeProject"`
		Cluster        string `json:"cluster"`
	}{s.Owner, s.directory, s.DockerHost, s.ComposeProject, s.Cluster})
	if err != nil {
		return nil, err
	}
	claims := &resourceClaims{root: root, owner: owner}
	for _, resource := range []string{"project\x00" + s.ComposeProject, "cluster\x00" + s.Cluster} {
		key := sha256.Sum256([]byte(filepath.Clean(endpoint) + "\x00" + resource))
		claims.paths = append(claims.paths, filepath.Join(root, fmt.Sprintf("%x.json", key)))
	}
	return claims, nil
}

func (c *resourceClaims) acquire() error {
	lock, err := lockClaims(c.root)
	if err != nil {
		return err
	}
	defer lock.Close()
	for _, path := range c.paths {
		if _, err := os.Lstat(path); !os.IsNotExist(err) {
			return fmt.Errorf("development resource is already claimed; recover its recorded stack using %s", path)
		}
	}
	for i, path := range c.paths {
		if err := exclusiveWrite(path, c.owner, 0600); err != nil {
			for _, created := range c.paths[:i] {
				_ = os.Remove(created)
			}
			return err
		}
	}
	return nil
}

func (c *resourceClaims) verify() error {
	for _, path := range c.paths {
		if err := privateOwned(path, false); err != nil {
			return err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if string(data) != string(c.owner) {
			return fmt.Errorf("development resource claim does not match recorded state: %s", path)
		}
	}
	return nil
}

func (c *resourceClaims) release() error {
	lock, err := lockClaims(c.root)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err := c.verify(); err != nil {
		return err
	}
	for _, path := range c.paths {
		if err := os.Remove(path); err != nil {
			return err
		}
	}
	return nil
}
