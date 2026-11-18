/*
 * isidore-sandbox: a tiny deny-by-default Landlock launcher for Pi workers.
 *
 *   isidore-sandbox [--rw PATH]... [--ro PATH]... [--rx PATH]...
 *                   [--connect-port PORT]... [--min-abi N] -- CMD ARGS...
 *
 *   --rw  full filesystem rights (incl. execute); the FIRST --rw is the
 *         task workspace and must exist.
 *   --ro  read_file + read_dir
 *   --rx  read_file + read_dir + execute
 *   --connect-port  allow TCP connect to this remote port (ABI >= 4). When
 *         no --connect-port is given, TCP connect is left unrestricted.
 *   --min-abi  raise the required Landlock ABI floor (default 4).
 *
 * Applies a Landlock ruleset to itself, then execvp(CMD). The exec preserves
 * the pid/pgid, so the supervisor's detached process-group kill still works
 * and a rule on /proc/self (resolved before exec) keeps matching the worker.
 *
 * FAIL CLOSED: any error (Landlock unavailable, ABI too low, bad ruleset,
 * missing workspace) prints "isidore-sandbox: <reason>" to stderr and exits
 * 126 WITHOUT executing the command. Missing optional paths are skipped with
 * a warning (e.g. /lib64 on systems without it).
 *
 * ABI notes (verified against linux/landlock.h):
 *   ABI 1: base fs rights; ABI 2: REFER; ABI 3: TRUNCATE;
 *   ABI 4: TCP bind/connect; ABI 5: IOCTL_DEV.
 * There is NO ptrace scope in Landlock (scopes are ABSTRACT_UNIX_SOCKET and
 * SIGNAL, ABI 6, deliberately not used here). Cross-pid /proc reads are
 * instead denied by giving /proc a narrow allow-list (see runner.ts
 * buildSandboxArgs): only /proc/self (the worker's own pid dir) plus global
 * proc files are readable.
 *
 * Raw syscalls are used because glibc 2.36 (bookworm) has no wrappers.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <linux/landlock.h>

#ifndef __NR_landlock_create_ruleset
#define __NR_landlock_create_ruleset 444
#endif
#ifndef __NR_landlock_add_rule
#define __NR_landlock_add_rule 445
#endif
#ifndef __NR_landlock_restrict_self
#define __NR_landlock_restrict_self 446
#endif
#ifndef LANDLOCK_ACCESS_FS_IOCTL_DEV
#define LANDLOCK_ACCESS_FS_IOCTL_DEV (1ULL << 15)
#endif
#ifndef LANDLOCK_ACCESS_NET_CONNECT_TCP
#define LANDLOCK_ACCESS_NET_CONNECT_TCP (1ULL << 1)
#endif

#define REQUIRED_ABI 4
#define MAX_RULES 512

/*
 * Minimal ruleset attribute: handled_access_fs + handled_access_net (the
 * ABI 4 layout). Passing a smaller struct than the running kernel knows is
 * the documented forward-compatible form; trailing fields (scoped, quiet_*)
 * default to 0. We deliberately set no scopes.
 */
struct ruleset_attr {
	uint64_t handled_access_fs;
	uint64_t handled_access_net;
};

struct path_beneath {
	uint64_t allowed_access;
	int32_t parent_fd;
} __attribute__((packed));

/*
 * Fixed 16-byte layout, defined here rather than taken from the host
 * headers: kernel v7.1 (Landlock ABI 9) widened .port from __u16 to __u64,
 * while bookworm's 6.1 headers still declare the old 10-byte struct. The
 * kernel copies min(user size, kernel size) and requires any extra user
 * bytes to be zero, so this layout works on BOTH:
 *  - old kernels (10-byte attr): they read allowed_access + the low 2 bytes
 *    of port; on little-endian those are exactly the u16 port value, and
 *    ports are <= 65535 so the trailing 6 bytes are zero anyway;
 *  - new kernels (16-byte attr): full u64 port, no out-of-bounds read of
 *    the caller's stack (a 10-byte buffer made the kernel copy 16 bytes of
 *    garbage -> EINVAL).
 */
struct net_port {
	uint64_t allowed_access;
	uint64_t port;
} __attribute__((packed));

/* Rights that only apply to directories; masked off for file targets. */
#define DIR_RIGHTS (LANDLOCK_ACCESS_FS_READ_DIR | \
		    LANDLOCK_ACCESS_FS_REMOVE_DIR | \
		    LANDLOCK_ACCESS_FS_REMOVE_FILE | \
		    LANDLOCK_ACCESS_FS_MAKE_CHAR | \
		    LANDLOCK_ACCESS_FS_MAKE_DIR | \
		    LANDLOCK_ACCESS_FS_MAKE_REG | \
		    LANDLOCK_ACCESS_FS_MAKE_SOCK | \
		    LANDLOCK_ACCESS_FS_MAKE_FIFO | \
		    LANDLOCK_ACCESS_FS_MAKE_BLOCK | \
		    LANDLOCK_ACCESS_FS_MAKE_SYM | \
		    LANDLOCK_ACCESS_FS_REFER)

static void die(const char *fmt, ...)
{
	va_list ap;
	fputs("isidore-sandbox: ", stderr);
	va_start(ap, fmt);
	vfprintf(stderr, fmt, ap);
	va_end(ap);
	fputc('\n', stderr);
	exit(126);
}

struct rule {
	const char *path;
	uint64_t rights;
};

int main(int argc, char **argv)
{
	struct rule rules[MAX_RULES];
	int nrules = 0;
	uint16_t ports[MAX_RULES];
	int nports = 0;
	int min_abi = REQUIRED_ABI;
	int workspace_rule = -1;
	int i;

	for (i = 1; i < argc; i++) {
		const char *arg = argv[i];
		if (strcmp(arg, "--") == 0) {
			i++;
			break;
		}
		if (strcmp(arg, "--min-abi") == 0) {
			if (++i >= argc)
				die("--min-abi needs a value");
			min_abi = atoi(argv[i]);
			continue;
		}
		if (strcmp(arg, "--connect-port") == 0) {
			long port;
			char *end;
			if (++i >= argc)
				die("--connect-port needs a value");
			port = strtol(argv[i], &end, 10);
			if (*end || port < 1 || port > 65535)
				die("bad --connect-port: %s", argv[i]);
			if (nports >= MAX_RULES)
				die("too many --connect-port rules");
			ports[nports++] = (uint16_t)port;
			continue;
		}
		if (strcmp(arg, "--rw") == 0 || strcmp(arg, "--ro") == 0 ||
		    strcmp(arg, "--rx") == 0) {
			uint64_t rights;
			if (++i >= argc)
				die("%s needs a path", arg);
			if (strcmp(arg, "--rw") == 0)
				rights = UINT64_MAX; /* capped below */
			else if (strcmp(arg, "--rx") == 0)
				rights = LANDLOCK_ACCESS_FS_READ_FILE |
					 LANDLOCK_ACCESS_FS_READ_DIR |
					 LANDLOCK_ACCESS_FS_EXECUTE;
			else
				rights = LANDLOCK_ACCESS_FS_READ_FILE |
					 LANDLOCK_ACCESS_FS_READ_DIR;
			if (nrules >= MAX_RULES)
				die("too many path rules");
			rules[nrules].path = argv[i];
			rules[nrules].rights = rights;
			/* First --rw is the workspace: must exist. */
			if (strcmp(arg, "--rw") == 0 && workspace_rule < 0)
				workspace_rule = nrules;
			nrules++;
			continue;
		}
		die("unknown argument: %s", arg);
	}
	if (i >= argc)
		die("missing command after --");
	if (workspace_rule < 0)
		die("at least one --rw (workspace) is required");

	/* Negotiate the kernel ABI. */
	long abi = syscall(__NR_landlock_create_ruleset, NULL, 0,
			   LANDLOCK_CREATE_RULESET_VERSION);
	if (abi < 0)
		die("landlock unavailable: %s", strerror(errno));
	if (abi < REQUIRED_ABI)
		die("landlock ABI %ld is below required ABI %d", abi,
		    REQUIRED_ABI);
	if (abi < min_abi)
		die("landlock ABI %ld is below required --min-abi %d", abi,
		    min_abi);

	/* Cap handled fs rights at the negotiated ABI. */
	uint64_t fs = LANDLOCK_ACCESS_FS_EXECUTE |
		      LANDLOCK_ACCESS_FS_WRITE_FILE |
		      LANDLOCK_ACCESS_FS_READ_FILE |
		      LANDLOCK_ACCESS_FS_READ_DIR |
		      LANDLOCK_ACCESS_FS_REMOVE_DIR |
		      LANDLOCK_ACCESS_FS_REMOVE_FILE |
		      LANDLOCK_ACCESS_FS_MAKE_CHAR |
		      LANDLOCK_ACCESS_FS_MAKE_DIR |
		      LANDLOCK_ACCESS_FS_MAKE_REG |
		      LANDLOCK_ACCESS_FS_MAKE_SOCK |
		      LANDLOCK_ACCESS_FS_MAKE_FIFO |
		      LANDLOCK_ACCESS_FS_MAKE_BLOCK |
		      LANDLOCK_ACCESS_FS_MAKE_SYM;
	if (abi >= 2)
		fs |= LANDLOCK_ACCESS_FS_REFER;
	if (abi >= 3)
		fs |= LANDLOCK_ACCESS_FS_TRUNCATE;
	if (abi >= 5)
		fs |= LANDLOCK_ACCESS_FS_IOCTL_DEV;
	/*
	 * ABI 9 adds LANDLOCK_ACCESS_FS_RESOLVE_UNIX (1ULL << 16). We do not
	 * handle it: unhandled rights stay unrestricted, which is the intended
	 * behaviour (UNIX socket pathname resolution is not a Phase 0 concern).
	 */

	struct ruleset_attr attr = {
		.handled_access_fs = fs,
		.handled_access_net = nports ? LANDLOCK_ACCESS_NET_CONNECT_TCP : 0,
	};
	long rs = syscall(__NR_landlock_create_ruleset, &attr, sizeof attr, 0);
	if (rs < 0)
		die("landlock_create_ruleset: %s", strerror(errno));

	for (int r = 0; r < nrules; r++) {
		int fd = open(rules[r].path, O_PATH | O_CLOEXEC);
		if (fd < 0) {
			if (r == workspace_rule)
				die("workspace %s: %s", rules[r].path,
				    strerror(errno));
			fprintf(stderr,
				"isidore-sandbox: warning: skipping %s: %s\n",
				rules[r].path, strerror(errno));
			continue;
		}
		uint64_t rights = rules[r].rights == UINT64_MAX
					  ? fs
					  : rules[r].rights & fs;
		struct stat st;
		if (fstat(fd, &st) == 0 && !S_ISDIR(st.st_mode))
			rights &= ~DIR_RIGHTS;
		struct path_beneath rule = { .allowed_access = rights,
					     .parent_fd = fd };
		if (syscall(__NR_landlock_add_rule, rs,
			    LANDLOCK_RULE_PATH_BENEATH, &rule, 0) < 0)
			die("landlock_add_rule(%s): %s", rules[r].path,
			    strerror(errno));
		close(fd);
	}
	for (int p = 0; p < nports; p++) {
		struct net_port rule = {
			.allowed_access = LANDLOCK_ACCESS_NET_CONNECT_TCP,
			.port = ports[p],
		};
		if (syscall(__NR_landlock_add_rule, rs, LANDLOCK_RULE_NET_PORT,
			    &rule, 0) < 0)
			die("landlock_add_rule(port %u): %s", (unsigned)ports[p],
			    strerror(errno));
	}

	if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0)
		die("PR_SET_NO_NEW_PRIVS: %s", strerror(errno));
	if (syscall(__NR_landlock_restrict_self, rs, 0) < 0)
		die("landlock_restrict_self: %s", strerror(errno));
	close(rs);

	execvp(argv[i], argv + i);
	die("execvp %s: %s", argv[i], strerror(errno));
	return 126; /* not reached */
}