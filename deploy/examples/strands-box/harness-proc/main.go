//go:build linux && (amd64 || arm64)

// The installed example uses this helper to read kernel data through a pinned procfs.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"syscall"
	"unsafe"
)

const (
	procMagic      = 0x9fa0
	originalProcFD = 3
	linuxOpenat2   = 437 // Linux amd64 and arm64
	resolveNoXDev  = 0x01
	resolveNoMagic = 0x02
	resolveNoSyms  = 0x04
	resolveBeneath = 0x08
	mountInfoLimit = 512 * 1024
)

type openHow struct {
	flags, mode, resolve uint64
}

type procPin struct {
	MountID string `json:"mountId"`
	Dev     string `json:"dev"`
	Ino     string `json:"ino"`
}

type snapshot struct {
	Proc      procPin `json:"proc"`
	BootID    string  `json:"bootId"`
	MountInfo string  `json:"mountinfo"`
}

func procDirectory(fd int) (syscall.Stat_t, error) {
	var fs syscall.Statfs_t
	var st syscall.Stat_t
	if err := syscall.Fstatfs(fd, &fs); err != nil {
		return st, err
	}
	if fs.Type != procMagic {
		return st, errors.New("procfs required")
	}
	if err := syscall.Fstat(fd, &st); err != nil {
		return st, err
	}
	if st.Mode&syscall.S_IFMT != syscall.S_IFDIR || st.Ino != 1 {
		return st, errors.New("procfs root required")
	}
	return st, nil
}

// NO_XDEV rejects a bind even when its source is another genuine procfs file.
func openKernelAt(proc int, path string, selfAlias bool) (*os.File, error) {
	name, err := syscall.BytePtrFromString(path)
	if err != nil {
		return nil, err
	}
	how := openHow{
		flags:   syscall.O_RDONLY | syscall.O_CLOEXEC | syscall.O_NONBLOCK,
		resolve: resolveBeneath | resolveNoXDev | resolveNoMagic | resolveNoSyms,
	}
	if selfAlias {
		how.resolve &^= resolveNoSyms
	}
	raw, _, errno := syscall.Syscall6(linuxOpenat2, uintptr(proc), uintptr(unsafe.Pointer(name)),
		uintptr(unsafe.Pointer(&how)), unsafe.Sizeof(how), 0, 0)
	if errno != 0 {
		return nil, errno
	}
	file := os.NewFile(raw, path)
	var fs syscall.Statfs_t
	var st syscall.Stat_t
	if syscall.Fstatfs(int(raw), &fs) != nil || fs.Type != procMagic ||
		syscall.Fstat(int(raw), &st) != nil || st.Mode&syscall.S_IFMT != syscall.S_IFREG {
		file.Close()
		return nil, errors.New("kernel procfs file required")
	}
	return file, nil
}

func readKernelAt(proc int, path string, selfAlias bool, limit int64) (string, error) {
	file, err := openKernelAt(proc, path, selfAlias)
	if err != nil {
		return "", err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil {
		return "", err
	}
	if len(data) == 0 || int64(len(data)) > limit {
		return "", errors.New("invalid procfs file size")
	}
	return string(data), nil
}

func mountID(proc int, self int, target int) (string, error) {
	path := fmt.Sprintf("%d/fdinfo/%d", self, target)
	info, err := readKernelAt(proc, path, false, 4096)
	if err != nil {
		return "", err
	}
	for _, row := range strings.Split(info, "\n") {
		if value, found := strings.CutPrefix(row, "mnt_id:"); found {
			id, err := strconv.ParseUint(strings.TrimSpace(value), 10, 64)
			if err == nil && id > 0 {
				return strconv.FormatUint(id, 10), nil
			}
			break
		}
	}
	return "", errors.New("procfs mount id unavailable")
}

func sameProcRoot(original int, self int) (int, procPin, error) {
	var pin procPin
	st, err := procDirectory(original)
	if err != nil {
		return -1, pin, err
	}
	current, err := syscall.Open("/proc", syscall.O_RDONLY|syscall.O_CLOEXEC|syscall.O_DIRECTORY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return -1, pin, err
	}
	observed, err := procDirectory(current)
	if err != nil || st.Dev != observed.Dev || st.Ino != observed.Ino {
		syscall.Close(current)
		return -1, pin, errors.New("procfs root replaced")
	}
	originalID, originalErr := mountID(current, self, original)
	currentID, currentErr := mountID(current, self, current)
	if originalErr != nil || currentErr != nil || originalID != currentID {
		syscall.Close(current)
		return -1, pin, errors.New("procfs mount replaced")
	}
	return current, procPin{MountID: originalID, Dev: strconv.FormatUint(uint64(st.Dev), 10), Ino: strconv.FormatUint(st.Ino, 10)}, nil
}

func readSnapshot(original int) (snapshot, error) {
	var result snapshot
	self, parent := os.Getpid(), os.Getppid()
	if parent <= 1 {
		return result, errors.New("installed Host parent required")
	}
	current, pin, err := sameProcRoot(original, self)
	if err != nil {
		return result, err
	}
	defer syscall.Close(current)
	alias, err := openKernelAt(current, "self/mountinfo", true)
	if err != nil {
		return result, err
	}
	defer alias.Close()
	numeric, err := openKernelAt(current, strconv.Itoa(self)+"/mountinfo", false)
	if err != nil {
		return result, err
	}
	defer numeric.Close()
	aliasStat, aliasErr := alias.Stat()
	numericStat, numericErr := numeric.Stat()
	if aliasErr != nil || numericErr != nil || !os.SameFile(aliasStat, numericStat) {
		return result, errors.New("procfs self does not resolve to the current process")
	}
	// The helper inherits the Host's mount namespace and root. Read the Host's
	// actual numeric path, which is what its procfs self link resolves to.
	mounts, err := readKernelAt(current, strconv.Itoa(parent)+"/mountinfo", false, mountInfoLimit)
	if err != nil {
		return result, err
	}
	ownMounts, err := io.ReadAll(io.LimitReader(alias, mountInfoLimit+1))
	if err != nil || string(ownMounts) != mounts {
		return result, errors.New("Host procfs mount view differs")
	}
	found := false
	for _, row := range strings.Split(mounts, "\n") {
		left, right, ok := strings.Cut(row, " - ")
		fields := strings.Fields(left)
		fs := strings.Fields(right)
		if ok && len(fields) >= 5 && len(fs) > 0 &&
			fields[0] == pin.MountID && fields[4] == "/proc" && fs[0] == "proc" {
			found = true
			break
		}
	}
	if !found {
		return result, errors.New("pinned procfs missing from Host mount view")
	}
	boot, err := readKernelAt(current, "sys/kernel/random/boot_id", false, 64)
	if err != nil {
		return result, err
	}
	check, endPin, err := sameProcRoot(original, self)
	if err != nil {
		return result, err
	}
	defer syscall.Close(check)
	if pin != endPin || os.Getppid() != parent {
		return result, errors.New("procfs custody changed")
	}
	for _, path := range []string{"self/mountinfo", strconv.Itoa(parent) + "/mountinfo", "sys/kernel/random/boot_id"} {
		file, err := openKernelAt(check, path, path == "self/mountinfo")
		if err != nil {
			return result, err
		}
		file.Close()
	}
	return snapshot{Proc: pin, BootID: strings.TrimSpace(boot), MountInfo: mounts}, nil
}

func main() {
	if len(os.Args) == 1 {
		if data, err := readSnapshot(originalProcFD); err == nil {
			if json.NewEncoder(os.Stdout).Encode(data) == nil {
				return
			}
		}
	}
	fmt.Fprintln(os.Stderr, "OCE_HARNESS_PROC_REFUSED")
	os.Exit(1)
}
