import { describe, expect, it } from "vitest";
import { askCount, asksWords, cardsWithoutTask, noTaskWords } from "../src/components/OwnerAsks";

// BOS-2638: the pure counts and wording behind the board's "Your review" strip and lane head.
// Made-up tickets and card ids only; nothing renders and no server is involved.

type Waiter = Parameters<typeof askCount>[0][number];

const ticket = (over: Partial<Waiter> & { id: string }): Waiter => ({
  title: `Made-up task ${over.id}`,
  number: null,
  ownerQuestionId: null,
  ...over,
});

describe("askCount", () => {
  it("is 0 for no waiting tickets", () => {
    expect(askCount([])).toBe(0);
  });

  it("counts a ticket with no card as its own ask", () => {
    expect(askCount([ticket({ id: "a" })])).toBe(1);
    expect(askCount([ticket({ id: "a" }), ticket({ id: "b" })])).toBe(2);
  });

  it("counts tickets on one question card once", () => {
    const waiting = [
      ticket({ id: "a", ownerQuestionId: "question-1" }),
      ticket({ id: "b", ownerQuestionId: "question-1" }),
      ticket({ id: "c", ownerQuestionId: "question-1" }),
    ];
    expect(askCount(waiting)).toBe(1);
  });

  it("counts a ticket's sign-off card when it has no question card", () => {
    const waiting = [
      ticket({ id: "a", waitingDecisionId: "signoff-1" }),
      ticket({ id: "b", waitingDecisionId: "signoff-1" }),
    ];
    expect(askCount(waiting)).toBe(1);
  });

  it("prefers the question card over the sign-off card, so one card still counts once", () => {
    const waiting = [
      ticket({ id: "a", ownerQuestionId: "question-1", waitingDecisionId: "signoff-a" }),
      ticket({ id: "b", ownerQuestionId: "question-1", waitingDecisionId: "signoff-b" }),
    ];
    expect(askCount(waiting)).toBe(1);
  });

  it("adds a cardless ticket to the cards of the others", () => {
    const waiting = [
      ticket({ id: "a", ownerQuestionId: "question-1" }),
      ticket({ id: "b" }),
    ];
    expect(askCount(waiting)).toBe(2);
  });
});

describe("asksWords", () => {
  it("says one task alone in the plain words", () => {
    expect(asksWords([ticket({ id: "a" })])).toBe("1 task is waiting on you.");
  });

  it("says several tasks on separate cards in the plain words", () => {
    const waiting = [
      ticket({ id: "a", ownerQuestionId: "question-1" }),
      ticket({ id: "b", ownerQuestionId: "question-2" }),
      ticket({ id: "c", ownerQuestionId: "question-3" }),
    ];
    expect(asksWords(waiting)).toBe("3 tasks are waiting on you.");
  });

  it("says one question holding several tasks", () => {
    const waiting = [
      ticket({ id: "a", ownerQuestionId: "question-1" }),
      ticket({ id: "b", ownerQuestionId: "question-1" }),
      ticket({ id: "c", ownerQuestionId: "question-1" }),
    ];
    expect(asksWords(waiting)).toBe("1 question is waiting on you, holding 3 tasks.");
  });

  it("says several questions holding more tasks than questions", () => {
    const waiting = [
      ticket({ id: "a", ownerQuestionId: "question-1" }),
      ticket({ id: "b", ownerQuestionId: "question-1" }),
      ticket({ id: "c", ownerQuestionId: "question-2" }),
    ];
    expect(asksWords(waiting)).toBe("2 questions are waiting on you, holding 3 tasks.");
  });
});

describe("cardsWithoutTask", () => {
  it("is 0 when the open-card count is unknown", () => {
    expect(cardsWithoutTask([ticket({ id: "a" })], null)).toBe(0);
    expect(cardsWithoutTask([ticket({ id: "a" })], undefined)).toBe(0);
  });

  it("is the open cards no waiting ticket holds", () => {
    const waiting = [
      ticket({ id: "a", ownerQuestionId: "question-1" }),
      ticket({ id: "b", ownerQuestionId: "question-1" }),
    ];
    expect(cardsWithoutTask(waiting, 2)).toBe(1);
    expect(cardsWithoutTask(waiting, 1)).toBe(0);
  });

  it("counts every open card when no ticket waits on one", () => {
    expect(cardsWithoutTask([], 3)).toBe(3);
    expect(cardsWithoutTask([ticket({ id: "a" })], 1)).toBe(1);
  });

  it("never goes below zero when the tickets hold more cards than the count shows", () => {
    const waiting = [
      ticket({ id: "a", ownerQuestionId: "question-1" }),
      ticket({ id: "b", ownerQuestionId: "question-2" }),
      ticket({ id: "c", ownerQuestionId: "question-3" }),
    ];
    expect(cardsWithoutTask(waiting, 1)).toBe(0);
  });
});

describe("noTaskWords", () => {
  it("says one card with no task", () => {
    expect(noTaskWords(1)).toBe("1 more question has no task: see Decisions.");
  });

  it("says more than one card with no task", () => {
    expect(noTaskWords(2)).toBe("2 more questions have no task: see Decisions.");
  });
});
