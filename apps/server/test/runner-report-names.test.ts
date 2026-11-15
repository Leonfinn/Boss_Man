import { describe, expect, it } from "vitest";
import type { LastUpdate } from "../src/services/maintenance.js";
import { reportNames } from "../src/services/runner-report.js";

// BOS-1354: reportNames decides whether a failed runner update's history names this company,
// so a company the failure doesn't name isn't blamed for it on its Settings → Runner panel.
const last = (body: string): LastUpdate => ({ at: "", startedAt: null, ok: false, title: "", body });

describe("reportNames (BOS-1354)", () => {
  describe("no slug", () => {
    it("is false when the slug is undefined, whatever the body says", () => {
      expect(reportNames(last("acme: Removing the runner failed"), undefined)).toBe(false);
    });

    it("is false when the slug is empty, whatever the body says", () => {
      expect(reportNames(last("acme: Removing the runner failed"), "")).toBe(false);
    });
  });

  describe("names the company", () => {
    it("finds the slug alone as the whole body", () => {
      expect(reportNames(last("acme"), "acme")).toBe(true);
    });

    it("finds the slug at the start of a line", () => {
      expect(reportNames(last("acme: Removing the runner failed"), "acme")).toBe(true);
    });

    it("finds the slug in the middle of a line", () => {
      expect(reportNames(last("Update for acme failed"), "acme")).toBe(true);
    });

    it("finds the slug at the end of a line", () => {
      expect(reportNames(last("Removing the runner failed for acme"), "acme")).toBe(true);
    });

    it("finds the slug inside brackets", () => {
      expect(reportNames(last("Removing the runner failed (acme)"), "acme")).toBe(true);
    });

    it("finds the slug before a colon", () => {
      expect(reportNames(last("acme: Removing the runner failed"), "acme")).toBe(true);
    });

    it("finds the slug before a full stop", () => {
      expect(reportNames(last("Removing the runner failed for acme."), "acme")).toBe(true);
    });

    it("finds the slug on the second line of a multi-line body", () => {
      expect(reportNames(last("Removing the runner failed\nacme could not be reached"), "acme")).toBe(true);
    });
  });

  describe("does not name the company", () => {
    it("ignores the slug inside a longer hyphenated slug after it", () => {
      expect(reportNames(last("acme-co: Removing the runner failed"), "acme")).toBe(false);
    });

    it("ignores the slug inside a longer hyphenated slug before it", () => {
      expect(reportNames(last("my-acme: Removing the runner failed"), "acme")).toBe(false);
    });

    it("ignores the slug with a digit joined on", () => {
      expect(reportNames(last("acme2: Removing the runner failed"), "acme")).toBe(false);
    });

    it("ignores the slug with a letter joined on", () => {
      expect(reportNames(last("xacme: Removing the runner failed"), "acme")).toBe(false);
    });

    it("ignores the slug in capitals (today's behaviour: matching is case-sensitive)", () => {
      expect(reportNames(last("ACME: Removing the runner failed"), "acme")).toBe(false);
    });

    it("ignores a body that names other companies only", () => {
      expect(reportNames(last("other-co: Removing the runner failed; third-co could not be reached"), "acme")).toBe(false);
    });
  });
});
