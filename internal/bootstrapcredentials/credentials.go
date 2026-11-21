// Package bootstrapcredentials prepares private inputs for local installation tools.
package bootstrapcredentials

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// Inputs are retained recovery files, not evidence of successful registration.
type Inputs struct {
	PasswordPath   string
	ServiceKeyPath string
	ClientKeyPath  string
}

// Prepare creates inputs exclusively in an existing private directory. An empty
// password selects a random password; development callers supply their own default.
// Partial failures retain evidence and must not be retried in the same directory.
func Prepare(directory, password string) (Inputs, error) {
	inputs := Inputs{
		PasswordPath:   filepath.Join(directory, "initial-admin-password"),
		ServiceKeyPath: filepath.Join(directory, "initial-admin-service-key"),
		ClientKeyPath:  filepath.Join(directory, "bootstrap-client-key.json"),
	}
	info, err := os.Lstat(directory)
	if err != nil || !info.IsDir() || info.Mode().Perm()&0077 != 0 {
		return inputs, errors.New("bootstrap input directory must be a private directory")
	}
	if password == "" {
		password = rand.Text()
	}
	if strings.HasSuffix(password, "\r\n") {
		password = strings.TrimSuffix(password, "\r\n")
	} else {
		password = strings.TrimSuffix(password, "\n")
	}
	if strings.ContainsAny(password, "\r\n\x00") {
		return inputs, errors.New("administrator password must not contain NUL or embedded line breaks")
	}
	material := make([]byte, 32)
	if _, err = rand.Read(material); err != nil {
		return inputs, err
	}
	key := "occ_" + base64.RawURLEncoding.EncodeToString(material)
	client, err := json.Marshal(map[string]any{"data": map[string]string{"key": key}})
	if err != nil {
		return inputs, err
	}
	for _, file := range []struct {
		path string
		data []byte
	}{{inputs.PasswordPath, []byte(password)}, {inputs.ServiceKeyPath, []byte(key)}, {inputs.ClientKeyPath, client}} {
		if err = write(file.path, file.data); err != nil {
			return inputs, err
		}
	}
	dir, err := os.Open(directory)
	if err != nil {
		return inputs, err
	}
	defer dir.Close()
	return inputs, dir.Sync()
}

func write(path string, data []byte) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	defer file.Close()
	if err = file.Chmod(0600); err != nil {
		return err
	}
	if _, err = file.Write(data); err != nil {
		return err
	}
	if err = file.Sync(); err != nil {
		return err
	}
	return file.Close()
}
