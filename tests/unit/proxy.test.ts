import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { GENESYS_REGIONS } from "@/lib/regions";
import { proxy } from "@/proxy";

const APP = "https://kf.example.com";

function directive(csp: string | null, name: string): string[] {
  const entry = (csp ?? "").split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name} `));
  return entry ? entry.split(/\s+/).slice(1) : [];
}

describe("proxy", () => {
  it("lets the sign-in form continue to every Genesys Cloud login host, and nowhere else", () => {
    const response = proxy(new NextRequest(`${APP}/login`));
    const formAction = directive(response.headers.get("content-security-policy"), "form-action");

    expect(formAction).toEqual(["'self'", ...GENESYS_REGIONS.map((region) => `https://login.${region.host}`)]);
    expect(formAction).toContain("https://login.mypurecloud.de");
    expect(formAction.some((source) => source.includes("*"))).toBe(false);
  });

  it("sends signed-out page requests to the login page and remembers where they were going", () => {
    const response = proxy(new NextRequest(`${APP}/syncs/abc?tab=activity`));
    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("returnTo")).toBe("/syncs/abc?tab=activity");
  });

  it("tags API requests with a request ID and leaves the CSP to pages", () => {
    const response = proxy(new NextRequest(`${APP}/api/syncs`));
    expect(response.headers.get("x-request-id")).toBeTruthy();
    expect(response.headers.get("content-security-policy")).toBeNull();
  });
});
