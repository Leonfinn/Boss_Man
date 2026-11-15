// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Project } from "../src/api";
import { ProjectLimitForm } from "../src/pages/ProjectBudget";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("creates a monthly limit for the project through the budget-policies route", async () => {
  const fetchMock = vi.fn(async () => new Response("{}", { status: 201 }));
  vi.stubGlobal("fetch", fetchMock);
  render(<ProjectLimitForm project={{ id: "11111111-1111-4111-8111-111111111111", name: "P" } as Project} />);
  fireEvent.change(screen.getByLabelText("Spending limit per month (USD)"), { target: { value: "25" } });
  fireEvent.change(screen.getByLabelText("At the limit"), { target: { value: "pause" } });
  fireEvent.click(screen.getByText("Add limit"));
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("/api/budget-policies");
  expect(init.method).toBe("POST");
  expect(JSON.parse(init.body as string)).toEqual({ scopeKind: "project", scopeId: "11111111-1111-4111-8111-111111111111", windowKind: "calendar_month", limitUsd: 25, onLimit: "pause" });
  expect(await screen.findByRole("status")).toBeTruthy();
});
