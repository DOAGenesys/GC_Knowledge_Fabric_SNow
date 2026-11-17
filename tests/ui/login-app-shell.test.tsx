import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import useSWR, { SWRConfig } from "swr";
import { describe, expect, it, vi } from "vitest";
import { AppShell } from "@/components/app-shell";
import { BrandIcon } from "@/components/brand";
import { LoginForm, type LoginNotice } from "@/components/login/login-form";
import { isDebugEnabled } from "@/lib/client-log";
import { errorBody, mockApi } from "./helpers/api";
import { navigation } from "./helpers/navigation";
import { blockStorage } from "./helpers/storage";

const CLIENT_ID = "1a2b3c4d-1234-4567-89ab-def012345678";
const REDIRECT = "http://localhost:3000/api/auth/callback";

function renderLogin(notice: LoginNotice | null = null) {
  const view = render(<LoginForm notice={notice} returnTo="/syncs/abc" redirectUri={REDIRECT} defaultRegion="mypurecloud.com" defaultClientId="" />);
  const form = view.container.querySelector("form")!;
  form.addEventListener("submit", (event) => event.preventDefault());
  return { ...view, form };
}

describe("LoginForm", () => {
  it("rejects a client ID that isn't a GUID", () => {
    const { form } = renderLogin();
    expect(form.getAttribute("action")).toBe("/api/auth/login");
    expect(form.getAttribute("method")).toBe("get");
    expect((form.querySelector("input[name='returnTo']") as HTMLInputElement).value).toBe("/syncs/abc");

    fireEvent.change(screen.getByLabelText("OAuth client ID"), { target: { value: "my-client" } });
    fireEvent.submit(form);
    expect(screen.getByText(/Enter the OAuth client ID: a GUID like/)).toBeTruthy();
    expect(screen.getByLabelText("OAuth client ID").getAttribute("aria-invalid")).toBe("true");
    expect(window.localStorage.getItem("kf:login")).toBeNull();
  });

  it("remembers the region and client ID for next time", () => {
    const { form, unmount } = renderLogin();
    fireEvent.change(screen.getByLabelText("Region"), { target: { value: "mypurecloud.de" } });
    fireEvent.change(screen.getByLabelText("OAuth client ID"), { target: { value: ` ${CLIENT_ID} ` } });
    fireEvent.submit(form);
    expect(JSON.parse(window.localStorage.getItem("kf:login") ?? "{}")).toEqual({ region: "mypurecloud.de", clientId: CLIENT_ID });
    expect(screen.getByRole("button", { name: /Continue to Genesys Cloud/ }).getAttribute("aria-busy")).toBe("true");
    unmount();

    renderLogin();
    expect((screen.getByLabelText("Region") as HTMLSelectElement).value).toBe("mypurecloud.de");
    expect((screen.getByLabelText("OAuth client ID") as HTMLInputElement).value).toBe(CLIENT_ID);
  });

  it("ignores remembered values it can't use", () => {
    window.localStorage.setItem("kf:login", JSON.stringify({ region: "evil.example.com", clientId: "nope" }));
    renderLogin();
    expect((screen.getByLabelText("Region") as HTMLSelectElement).value).toBe("mypurecloud.com");
    expect((screen.getByLabelText("OAuth client ID") as HTMLInputElement).value).toBe("");
  });

  it("survives corrupt or blocked storage", () => {
    window.localStorage.setItem("kf:login", "{not json");
    const { form } = renderLogin();
    blockStorage();
    fireEvent.change(screen.getByLabelText("OAuth client ID"), { target: { value: CLIENT_ID } });
    expect(() => fireEvent.submit(form)).not.toThrow();
  });

  it("shows sign-in problems and logs them once", () => {
    renderLogin({ tone: "danger", title: "Sign-in failed", message: "Genesys Cloud didn't complete the sign-in.", hint: "Try again." });
    expect(screen.getByRole("alert").textContent).toContain("Sign-in failed");
    expect(screen.getByText("Try again.")).toBeTruthy();
    expect(vi.mocked(console.warn).mock.calls.map((call) => call[0])).toEqual(["%cKF%c login · Sign-in problem shown: Sign-in failed"]);
  });

  it("shows informational notices without logging", () => {
    renderLogin({ tone: "info", title: "Please sign in again", message: "Your session ended." });
    expect(screen.getByRole("status").textContent).toContain("Please sign in again");
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("explains the OAuth client setup with a copyable redirect URI", async () => {
    renderLogin();
    expect(screen.getByText("First time here? Set up the OAuth client")).toBeTruthy();
    expect(screen.getByText(REDIRECT)).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy redirect URI" })));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(REDIRECT);
    expect(screen.getByRole("group", { name: "EMEA" })).toBeTruthy();
  });
});

function FailingChild({ path }: { path: string }) {
  const { error } = useSWR<unknown>(path);
  return <p>{error ? "Child failed" : "Child loading"}</p>;
}

function renderShellWith(path: string) {
  return render(
    <AppShell user={{ name: "Jordan Example" }} org={{ name: "Example Org", region: "mypurecloud.de" }} version="1.0.0-test">
      <SWRConfig value={{ errorRetryInterval: 10 }}>
        <FailingChild path={path} />
      </SWRConfig>
    </AppShell>,
  );
}

function renderShell(name = "Jordan Example") {
  return render(
    <AppShell user={{ name }} org={{ name: "Example Org", region: "mypurecloud.de" }} version="1.0.0-test">
      <p>Page content</p>
    </AppShell>,
  );
}

describe("AppShell", () => {
  it("renders the brand, navigation and footer, highlighting the current section", () => {
    navigation.pathname = "/syncs/abc";
    const { unmount } = renderShell();
    expect(screen.getByRole("link", { name: "Knowledge Sync home" }).getAttribute("href")).toBe("/");
    expect(screen.getByRole("link", { name: "Syncs" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Connections" }).hasAttribute("aria-current")).toBe(false);
    expect(screen.getByText("Page content")).toBeTruthy();
    expect(screen.getByText("Version 1.0.0-test")).toBeTruthy();
    expect(screen.getByText("JE")).toBeTruthy();
    unmount();

    navigation.pathname = "/connections";
    renderShell("Cher");
    expect(screen.getByRole("link", { name: "Connections" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByText("C")).toBeTruthy();
  });

  it("opens the user menu and closes it with Escape or a click outside", () => {
    renderShell(" ");
    expect(screen.getByText("?")).toBeTruthy();
    const trigger = screen.getByRole("button", { expanded: false });
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");

    fireEvent.click(trigger);
    const menu = screen.getByRole("menu");
    expect(menu.textContent).toContain("Example Org");
    expect(menu.textContent).toContain("mypurecloud.de");
    fireEvent.pointerDown(menu);
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("toggles verbose logging from the menu", () => {
    renderShell();
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    const toggle = screen.getByRole("switch", { name: /Verbose logging/ });
    fireEvent.click(toggle);
    expect(isDebugEnabled()).toBe(true);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(vi.mocked(console.info).mock.calls.some((call) => String(call[0]).includes("Verbose logging turned on"))).toBe(true);
    fireEvent.click(toggle);
    expect(isDebugEnabled()).toBe(false);
  });

  it("signs out, even when the sign-out request fails", async () => {
    const assign = vi.spyOn(window.location, "assign").mockImplementation(() => undefined);
    const api = mockApi({ "POST /api/auth/logout": { status: 204 } });
    const { unmount } = renderShell();
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    await act(async () => fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" })));
    expect(api.callsTo("POST", "/api/auth/logout")).toHaveLength(1);
    expect(assign).toHaveBeenCalledWith("/login");
    unmount();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("offline");
      }),
    );
    renderShell();
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    await act(async () => fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" })));
    expect(assign).toHaveBeenCalledTimes(2);
    expect(vi.mocked(console.warn).mock.calls.some((call) => String(call[0]).includes("Sign-out request failed"))).toBe(true);
  });

  it("doesn't retry client errors from data hooks", async () => {
    const api = mockApi({ "GET /api/gone": { status: 404, body: errorBody("NOT_FOUND", "Not found.") } });
    renderShellWith("/api/gone");
    expect(await screen.findByText("Child failed")).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(api.callsTo("GET", "/api/gone")).toHaveLength(1);
  });

  it("retries server errors from data hooks", async () => {
    const api = mockApi({ "GET /api/flaky": { status: 503, body: errorBody("GC_UNAVAILABLE", "Down.") } });
    renderShellWith("/api/flaky");
    expect(await screen.findByText("Child failed")).toBeTruthy();
    await waitFor(() => expect(api.callsTo("GET", "/api/flaky").length).toBeGreaterThan(1), { timeout: 3_000 });
  });
});

describe("BrandIcon", () => {
  it("renders a decorative brand illustration", () => {
    const { container } = render(<BrandIcon name="clock" size={30} />);
    const image = container.querySelector("img")!;
    expect(image.getAttribute("src")).toBe("/brand/icon-clock.svg");
    expect(image.getAttribute("alt")).toBe("");
    expect(image.getAttribute("width")).toBe("30");
  });
});
