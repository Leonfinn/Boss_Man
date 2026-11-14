// The words that tell an agent where each of its notes came from (BOS-1350).
import { describe, expect, it } from "vitest";
import { originOf } from "../src/services/agent-notes.js";

type TestNote = Parameters<typeof originOf>[0];

const note = (over: Partial<TestNote>): TestNote => ({
  id: "00000000-0000-0000-0000-000000000000",
  title: "A note",
  text: "Say it",
  why: "Because",
  source: "chat",
  ...over,
});

describe("originOf", () => {
  it("says who asked and on which ticket for an accepted request", () => {
    expect(originOf(note({ source: "request", requestedBy: "Rosalie", ticketRef: "BOS-12" }))).toBe("asked by Rosalie on BOS-12, accepted by you");
  });

  it("leaves out the ticket for an accepted request with no ticket", () => {
    expect(originOf(note({ source: "request", requestedBy: "Rosalie", ticketRef: null }))).toBe("asked by Rosalie, accepted by you");
    expect(originOf(note({ source: "request", requestedBy: "Rosalie" }))).toBe("asked by Rosalie, accepted by you");
  });

  it("names a former agent when the requester is gone", () => {
    expect(originOf(note({ source: "request", requestedBy: null, ticketRef: "BOS-12" }))).toBe("asked by a former agent on BOS-12, accepted by you");
    expect(originOf(note({ source: "request", requestedBy: null }))).toBe("asked by a former agent, accepted by you");
  });

  it("says the owner wrote it, whatever ticket it names", () => {
    expect(originOf(note({ source: "owner", ticketRef: "BOS-12" }))).toBe("written by the owner");
    expect(originOf(note({ source: "owner", ticketRef: null }))).toBe("written by the owner");
    expect(originOf(note({ source: "owner" }))).toBe("written by the owner");
  });

  it("says which ticket the owner's message was on", () => {
    expect(originOf(note({ source: "ticket", ticketRef: "BOS-12" }))).toBe("saved from the owner's message on BOS-12");
  });

  it("says on a ticket when the ticket is missing", () => {
    expect(originOf(note({ source: "ticket", ticketRef: null }))).toBe("saved from the owner's message on a ticket");
    expect(originOf(note({ source: "ticket" }))).toBe("saved from the owner's message on a ticket");
  });

  it("says the owner chat for a chat note", () => {
    expect(originOf(note({ source: "chat", ticketRef: "BOS-12" }))).toBe("saved from the owner chat");
  });

  it("says the owner chat for an unknown source", () => {
    expect(originOf(note({ source: "portal" }))).toBe("saved from the owner chat");
    expect(originOf(note({ source: "email", ticketRef: "BOS-12" }))).toBe("saved from the owner chat");
  });
});
