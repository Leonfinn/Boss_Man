import { describe, expect, it } from "vitest";
import { REDACTIONS, redact } from "../src/redact.js";

// The shared redactor is imported by both the server and the runner, so these tests pin the
// patterns themselves: a token shape that stops being redacted leaks into a run event or a trace.

describe("REDACTIONS list", () => {
  it("has a global pattern for every entry, so replace() cleans every occurrence in a line", () => {
    expect(REDACTIONS.length).toBeGreaterThan(0);
    for (const [re, to] of REDACTIONS) {
      expect(re.flags).toContain("g");
      expect(typeof to).toBe("string");
    }
  });
});

describe("redact: Boss Man's own run tokens", () => {
  it("redacts a run token and a runner token", () => {
    expect(redact("run bm_run_abcDEF123 done")).toBe("run bm_run_[redacted] done");
    expect(redact("runner bmr_xyz789 started")).toBe("runner bmr_[redacted] started");
  });

  it("redacts every token on a line, not just the first", () => {
    expect(redact("bm_run_one bm_run_two_b bmr_three4")).toBe("bm_run_[redacted] bm_run_[redacted] bmr_[redacted]");
  });
});

describe("redact: authorisation headers", () => {
  it("keeps the scheme word and redacts a Bearer token", () => {
    expect(redact("Authorization: Bearer abc.def.123")).toBe("Authorization: Bearer [redacted]");
  });

  it("keeps the case the line used", () => {
    expect(redact("authorization: bearer abcDEF123")).toBe("authorization: bearer [redacted]");
  });

  it("redacts a Basic credential", () => {
    expect(redact("Authorization: Basic dXNlcjpwYXNz")).toBe("Authorization: Basic [redacted]");
  });
});

describe("redact: provider keys", () => {
  it("redacts an sk- key, including the longer Anthropic shapes", () => {
    expect(redact("key sk-abcdefghijklmnop")).toBe("key sk-[redacted]");
    expect(redact("token sk-ant-oat01-abcdefghijklmnop")).toBe("token sk-[redacted]");
  });

  it("redacts the classic GitHub token prefixes", () => {
    for (const prefix of ["ghp", "gho", "ghu", "ghs", "ghr"]) {
      expect(redact(`GITHUB ${prefix}_1234567890abcdefghij`)).toBe("GITHUB gh[redacted]");
    }
  });

  it("redacts a fine-grained GitHub token, naming its own shape", () => {
    expect(redact("GITHUB github_pat_EXAMPLE_abcdefghij")).toBe("GITHUB github_pat_[redacted]");
  });
});

describe("redact: secrets in URLs, query strings and key-value pairs", () => {
  it("redacts a password in a URL and keeps the user and host", () => {
    expect(redact("https://user:hunter2@example.com/x")).toBe("https://user:[redacted]@example.com/x");
  });

  it("redacts a query parameter and leaves the rest of the query", () => {
    expect(redact("https://example.com/x?token=supersecret&x=1")).toBe("https://example.com/x?token=[redacted]&x=1");
    expect(redact("https://example.com/x?api_key=abc123")).toBe("https://example.com/x?api_key=[redacted]");
    expect(redact("https://example.com/x?secret=abc123")).toBe("https://example.com/x?secret=[redacted]");
  });

  it("redacts the value of a TOKEN, SECRET, KEY or PASSWORD assignment and keeps the name", () => {
    expect(redact("GITHUB_TOKEN=ghp_1234567890abcdefghij")).toBe("GITHUB_TOKEN=[redacted]");
    expect(redact("DB_PASSWORD=pw123456")).toBe("DB_PASSWORD=[redacted]");
    expect(redact("OPENAI_API_KEY=abc123")).toBe("OPENAI_API_KEY=[redacted]");
  });

  it("redacts a secret field in JSON and keeps the quotes and the other fields", () => {
    expect(redact('{"password":"hunter2","user":"bob"}')).toBe('{"password":"[redacted]","user":"bob"}');
    expect(redact('{"apiKey":"sk-123456789"}')).toBe('{"apiKey":"[redacted]"}');
  });

  it("redacts a YAML or .env line's value and keeps its indentation and key", () => {
    expect(redact("database:\n  password: hunter2\n  user: bob")).toBe("database:\n  password: [redacted]\n  user: bob");
    expect(redact("api_key: abc123def")).toBe("api_key: [redacted]");
  });
});

describe("redact: session cookies", () => {
  it("redacts the owner session cookie wherever it appears", () => {
    expect(redact("cookie bm_session=abc123secret")).toBe("cookie bm_session=[redacted]");
  });

  it("redacts a whole Cookie header, session cookie or not", () => {
    expect(redact("Cookie: bm_session=abc123secret; other=1")).toBe("Cookie: [redacted]");
    expect(redact("Cookie: theme=dark; lang=en")).toBe("Cookie: [redacted]");
  });
});

describe("redact: shapes only tool output carries", () => {
  // Built from parts so the marker is not written out as a literal in the source (the commit
  // secrets scan treats a bare marker as a real private key and cannot tell a test from a leak).
  const BEGIN = ["-----BEGIN", "RSA", "PRIVATE KEY-----"].join(" ");
  const END = ["-----END", "RSA", "PRIVATE KEY-----"].join(" ");

  it("redacts a multi-line PEM private key body but keeps its BEGIN and END lines", () => {
    const pem = `${BEGIN}\nEXAMPLESECRET\nmore\n${END}`;
    const out = redact(pem);
    expect(out).not.toContain("EXAMPLESECRET");
    expect(out).toBe(`${BEGIN}[redacted]${END}`);
  });

  it("redacts a JWT", () => {
    const jwt = "eyJHEADERxy.eyJPAYLOADz.EXAMPLESIG";
    expect(redact(`token ${jwt}`)).toBe("token eyJ[redacted]");
  });

  it("redacts everything after a failed query", () => {
    expect(redact("Failed query: select * from users where password='x'")).toBe("Failed query [redacted]");
  });
});

describe("redact: clean text", () => {
  it("leaves ordinary text alone", () => {
    for (const text of [
      "The build finished in 12s.",
      "merged as 9f384c479d0fb37cef7eaaf3ffe00674d214a6e7",
      "See docs/10-migrations.md",
      "run 42 passed",
    ]) {
      expect(redact(text)).toBe(text);
    }
  });

  it("is idempotent on a line holding several secrets", () => {
    const line = "Bearer abc.def bm_run_xyz GITHUB_TOKEN=ghp_1234567890abcdefghij https://user:hunter2@example.com/";
    const once = redact(line);
    expect(redact(once)).toBe(once);
  });
});
