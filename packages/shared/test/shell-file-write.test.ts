import { describe, expect, it } from "vitest";
import { SHELL_FILE_WRITE_HINT, shellFileWriteRefusal } from "../src/index.js";

// BOS-2856. A made-up scratch folder; the real one is $BOSSMAN_SCRATCH.
const S = "$BOSSMAN_SCRATCH";

describe("a shell command that writes a file is refused with the fixed hint (BOS-2856)", () => {
  it.each([
    ["echo append", `echo 'node x.js' >> ${S}/run.sh`],
    ["echo overwrite", `echo hi > ${S}/a.txt`],
    ["echo no space", "echo hi>a.txt"],
    ["echo clobber", "echo hi >| a.txt"],
    ["echo both streams", "echo hi &> a.txt"],
    ["echo >&file", "echo hi >& a.txt"],
    ["printf", `printf '%s\\n' a b > ${S}/list.txt`],
    ["quoted target", `echo hi >> "${S}/my file.txt"`],
    ["fd 3 target", "echo hi 3> a.txt"],
    ["empty redirect", "> a.txt"],
    ["colon redirect", ": > a.txt"],
    ["here-doc into cat", "cat <<EOF > a.sh\necho hi\nEOF"],
    ["here-doc quoted delimiter", "cat > a.sh <<'EOF'\necho $HOME > b\nEOF"],
    ["here-doc dash form", "cat <<-EOF > a.sh\n\techo hi\n\tEOF"],
    ["here-string", "cat <<< 'hi' > a.txt"],
    ["pipe into cat", "echo hi | cat > a.txt"],
    ["tee fed by echo", "echo hi | tee a.txt"],
    ["tee -a fed by printf", "printf hi | tee -a a.txt"],
    ["tee after sudo", "echo hi | sudo tee /etc/x"],
    ["tee fed by here-doc", "tee a.txt <<EOF\nhi\nEOF"],
    ["tee after cat here-doc", "cat <<EOF | tee a.txt\nhi\nEOF"],
    ["tee chain", "echo hi | tee a.txt | tee b.txt"],
    ["sed -i", "sed -i 's/a/b/' x.txt"],
    ["sed -i suffix", "sed -i.bak 's/a/b/' x.txt"],
    ["sed -ni cluster", "sed -ni '1p' x.txt"],
    ["sed --in-place", "sed --in-place=.bak 's/a/b/' x.txt"],
    ["perl -pi", "perl -pi -e 's/a/b/' x.txt"],
    ["perl -i.bak", "perl -i.bak -pe 's/a/b/' x.txt"],
    ["perl -0777pi", "perl -0777pi -e 's/a/b/' x.txt"],
    ["after chaining", "cd /tmp/x && echo hi >> a.txt"],
    ["after semicolon", "ls; echo hi >> a.txt"],
    ["after newline", "ls\necho hi >> a.txt"],
    ["env prefix", "FOO=1 echo hi > a.txt"],
    ["full path program", "/usr/bin/sed -i s/a/b/ x"],
    ["bash -c", `bash -c 'echo hi >> ${S}/a.txt'`],
    ["bash -lc", "bash -lc \"echo hi > a.txt\""],
    ["sh -c", "sh -c 'sed -i s/a/b/ x'"],
    ["eval", "eval 'echo hi > a.txt'"],
    ["command substitution", "echo $(echo hi > a.txt)"],
    ["backticks", "echo `echo hi > a.txt`"],
    ["inside a loop", "for f in a b; do echo hi >> $f; done"],
    ["inside an if", "if true; then echo hi > a.txt; fi"],
    ["after && with log redirect elsewhere", "npm test > out.log 2>&1 && echo hi >> a.txt"],
  ])("%s", (_name, cmd) => {
    expect(shellFileWriteRefusal(cmd), cmd).toBe(`${SHELL_FILE_WRITE_HINT} This request was refused at once and no one was asked.`);
  });
});

describe("what keeps today's handling (BOS-2856 must-stay rows)", () => {
  it.each([
    ["write to /dev/null", "echo hi > /dev/null"],
    ["append to /dev/null", "echo hi >> /dev/null"],
    // test-lines-ok: command text is the input under test, nothing here runs it
    ["both streams to /dev/null", "echo hi &> /dev/null"],
    ["program output to a log, both streams", `npm test > ${S}/out.log 2>&1`],
    ["program output to a log, append", `node run.js >> ${S}/out.log 2>&1`],
    ["log of a script run by full path", `${S}/run.sh > ${S}/out.log 2>&1`],
    ["stderr only to a log", `echo hi 2> ${S}/err.log`],
    // test-lines-ok: command text is the input under test, nothing here runs it
    ["stderr to /dev/null", "ls 2>/dev/null"],
    ["fd copy", "echo hi >&2"],
    ["fd copy both", "ls 2>&1"],
    // test-lines-ok: command text is the input under test, nothing here runs it
    ["fd close", "ls 2>&-"],
    ["tee of program output (a log)", `npm test 2>&1 | tee ${S}/out.log`],
    ["tee of cat on a file", `cat a.log | tee ${S}/b.log`],
    ["tee to /dev/null", "echo hi | tee /dev/null"],
    ["tee with no file", "echo hi | tee"],
    ["cat of files to a file", "cat a b > c"],
    ["cat one file to a file", "cat a > b"],
    ["program with a here-doc, output to a log", "python3 - <<EOF > out.log\nprint(1 > 0)\nEOF"],
    ["a > inside a here-doc body is not a redirect", "python3 - <<'EOF'\nif x > 1: pass\nEOF"],
    ["a > inside single quotes", "echo 'a > b'"],
    ["a > inside double quotes", 'echo "a >> b"'],
    ["a > in arithmetic", "echo $((3 > 2))"],
    ["a comment", "ls # echo hi > a.txt"],
    ["a group redirected to a log", "for f in a b; do ./t $f; done > out.log"],
    ["a subshell redirected to a log", "(npm test) > out.log"],
    ["exec redirect", "exec > out.log 2>&1"],
    ["input redirect", "wc -l < a.txt"],
    ["sed without -i", "sed 's/a/b/' x.txt"],
    ["sed -n with an expression", "sed -n '1,5p' x.txt"],
    ["sed -e script", "sed -e 's/a/b/' x.txt"],
    ["perl -e", "perl -e 'print 1'"],
    ["perl -pe", "perl -pe 's/a/b/' x.txt"],
    ["rm in scratch (out of scope)", `rm -rf ${S}/x`],
    ["git clone in scratch (out of scope)", `git clone --shared /a ${S}/x`],
    ["plain read", "ls -la"],
    ["echo with no redirect", "echo hi"],
    ["bash -c with no write", "bash -c 'echo hi'"],
    ["an empty command", ""],
  ])("%s", (_name, cmd) => {
    expect(shellFileWriteRefusal(cmd), cmd).toBeNull();
  });

  it("gives up on a very long command and on deep nesting (the old route stands)", () => {
    expect(shellFileWriteRefusal(`echo ${"a".repeat(10_001)} > f`)).toBeNull();
    expect(shellFileWriteRefusal(`${"$(".repeat(8)}echo hi > f${")".repeat(8)}`)).toBeNull();
  });

  it("never repeats the command in the hint", () => {
    expect(shellFileWriteRefusal("echo SECRET_WORD_9 >> a")).not.toContain("SECRET_WORD_9");
  });
});
