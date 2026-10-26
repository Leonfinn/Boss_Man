// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Markdown } from "../src/components/Markdown";

afterEach(cleanup);

describe("wiki links", () => {
  it("renders [[slug]] and [[slug#Section]] as links to the wiki page", () => {
    render(<Markdown text="See [[research/landscape]] and [[deploy#Rollback]]." wikiCompanyId="c1" />);
    expect(screen.getByRole("link", { name: "research/landscape" }).getAttribute("href")).toBe("#/wiki/c1/research/landscape");
    expect(screen.getByRole("link", { name: "deploy#Rollback" }).getAttribute("href")).toBe("#/wiki/c1/deploy");
  });
});

describe("images in a wiki page", () => {
  it("shows a ticket image inline from the company's image route", () => {
    render(<Markdown text="![Leap year result](/api/ticket-images/11111111-2222-3333-4444-555555555555)" wikiCompanyId="c1" />);
    expect(screen.getByRole("img", { name: "Leap year result" }).getAttribute("src")).toBe("/api/ticket-images/11111111-2222-3333-4444-555555555555");
  });
});
