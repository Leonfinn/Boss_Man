#!/usr/bin/perl
# The agent fence (DR-004, BOS-321): restricts itself with Landlock, then execs the command, which
# inherits the fence with everything it starts. Unprivileged, and it can't be undone from inside.
#
#   landlock.pl --probe
#       prints {"abi":N,"errno":null|"ENOSYS"|...} and exits 0; abi 0 means no Landlock here.
#   landlock.pl [--ro DIR]... [--rw DIR]... [--rofile FILE]... [--rwfile FILE]... [--no-scope] -- CMD ARGS...
#       --ro: read and run beneath DIR; --rw: anything beneath DIR; *file: the same for one file.
#       Signals and abstract unix sockets are scoped to the fence on ABI 6+ unless --no-scope.
#       A path that doesn't exist is skipped. Refuses (exit 125) below ABI 2, where every rename
#       across folders is refused and git and pnpm break.
#
# Perl, not C: perl-base is in every runner image, so there is no build step, and the tests run
# anywhere. The cost is ~17 ms once per session (BOS-315, E5).
use strict;
use warnings;
use POSIX ();

sub fail { print STDERR "fence: $_[0]\n"; exit 125 }

# landlock_create_ruleset/add_rule/restrict_self share one number on every architecture since
# Linux 5.13; prctl doesn't. Only architectures listed here are fenced.
my %PRCTL = (x86_64 => 157, aarch64 => 167);
my $machine = (POSIX::uname())[4];
my ($SYS_create, $SYS_add, $SYS_restrict) = (444, 445, 446);

sub probe {
  return (0, "unsupported architecture $machine") unless exists $PRCTL{$machine};
  my $abi = syscall($SYS_create, 0, 0, 1);    # LANDLOCK_CREATE_RULESET_VERSION
  return ($abi, undef) if $abi > 0;
  my %names = (POSIX::ENOSYS() => "ENOSYS", 95 => "EOPNOTSUPP", POSIX::EPERM() => "EPERM");
  my $n = $! + 0;
  return (0, $names{$n} // "errno $n");
}

my (@ro, @rw, @rofile, @rwfile);
my $scope = 1;
while (@ARGV) {
  my $a = shift @ARGV;
  last if $a eq '--';
  if ($a eq '--probe') {
    my ($abi, $err) = probe();
    print defined $err ? qq({"abi":$abi,"errno":"$err"}\n) : qq({"abi":$abi,"errno":null}\n);
    exit 0;
  }
  elsif ($a eq '--ro') { push @ro, shift @ARGV }
  elsif ($a eq '--rw') { push @rw, shift @ARGV }
  elsif ($a eq '--rofile') { push @rofile, shift @ARGV }
  elsif ($a eq '--rwfile') { push @rwfile, shift @ARGV }
  elsif ($a eq '--no-scope') { $scope = 0 }
  else { fail("unknown option $a") }
}
fail("no command given") unless @ARGV;

my ($abi, $err) = probe();
fail("Landlock is unavailable here ($err)") if $abi < 1;
fail("Landlock ABI $abi can't fence agents (renames across folders are always refused below ABI 2)") if $abi < 2;

# Filesystem rights, include/uapi/linux/landlock.h.
my ($EXECUTE, $WRITE_FILE, $READ_FILE, $READ_DIR) = (1 << 0, 1 << 1, 1 << 2, 1 << 3);
my ($REFER, $TRUNCATE, $IOCTL_DEV) = (1 << 13, 1 << 14, 1 << 15);
my $handled = (1 << 13) - 1;    # ABI 1: bits 0..12
$handled |= $REFER;              # ABI 2
$handled |= $TRUNCATE if $abi >= 3;
$handled |= $IOCTL_DEV if $abi >= 5;
my $dir_ro = $EXECUTE | $READ_FILE | $READ_DIR;
my $file_ro = $EXECUTE | $READ_FILE;
my $file_rw = ($EXECUTE | $WRITE_FILE | $READ_FILE | $TRUNCATE | $IOCTL_DEV) & $handled;
my $scoped = ($abi >= 6 && $scope) ? 3 : 0;    # ABSTRACT_UNIX_SOCKET | SIGNAL

# struct landlock_ruleset_attr grew with each ABI; the network field stays 0 (not handled).
my $attr = $abi >= 6 ? pack('QQQ', $handled, 0, $scoped) : pack('Q', $handled);
my $rs = syscall($SYS_create, $attr, length($attr), 0);
fail("landlock_create_ruleset: $!") if $rs < 0;

sub rule {
  my ($path, $access) = @_;
  my $fd = POSIX::open($path, 0x200000 | 0x80000);    # O_PATH | O_CLOEXEC
  return unless defined $fd;                          # a missing path grants nothing
  $access &= $file_rw | $file_ro unless -d $path;     # folder rights on a file are refused (EINVAL)
  # struct landlock_path_beneath_attr is packed: u64 allowed_access, s32 parent_fd.
  my $r = syscall($SYS_add, $rs, 1, pack('Ql', $access, $fd), 0);
  my $e = $!;
  POSIX::close($fd);
  fail("landlock_add_rule $path: $e") if $r < 0;
}
rule($_, $dir_ro) for @ro;
rule($_, $handled) for @rw;
rule($_, $file_ro) for @rofile;
rule($_, $file_rw) for @rwfile;

syscall($PRCTL{$machine}, 38, 1, 0, 0, 0) == 0 or fail("prctl(PR_SET_NO_NEW_PRIVS): $!");
syscall($SYS_restrict, $rs, 0) == 0 or fail("landlock_restrict_self: $!");
POSIX::close($rs);
exec { $ARGV[0] } @ARGV or fail("can't run $ARGV[0]: $!");
