import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConnectionsPage } from "@/components/connections/connections-page";
import type { ConnectionDTO } from "@/lib/api-types";
import { errorBody, mockApi, type Route } from "./helpers/api";
import { CONNECTION_ID, makeConnection, makeCredentials, makeSession } from "./helpers/fixtures";
import { renderUi } from "./helpers/render";

const STAGING_ID = "33333333-3333-4333-8333-333333333333";
const production = makeConnection({ syncCount: 2 });
const staging = makeConnection({
  id: STAGING_ID,
  name: "Acme staging",
  instanceUrl: "https://acme-dev.service-now.com",
  authType: "oauth",
  principal: "client-abc",
  status: "error",
  statusMessage: "ServiceNow rejected the credentials.",
  checkedAt: null,
});

function setup(extra: Record<string, Route> = {}) {
  const api = mockApi({
    "GET /api/connections": { body: { connections: [production, staging] } },
    "GET /api/genesys/credentials": { body: { credentials: makeCredentials() } },
    "GET /api/session": { body: makeSession() },
    ...extra,
  });
  renderUi(<ConnectionsPage />);
  return api;
}

const genesysCard = () => within(document.getElementById("genesys")!);
const dialog = () => within(screen.getByRole("dialog"));

describe("ServiceNow connections", () => {
  it("lists connections with status, usage and requirements", async () => {
    setup();
    const productionRow = within((await screen.findByText("Acme production")).closest("li")!);
    expect(productionRow.getByText("Connected")).toBeTruthy();
    expect(screen.getByText("Can't connect")).toBeTruthy();
    expect(screen.getByText("ServiceNow rejected the credentials.")).toBeTruthy();
    expect(screen.getByText(/^Username & password · svc_knowledge · Used by 2 syncs · Checked .+/)).toBeTruthy();
    expect(screen.getByText("OAuth client · client-abc · Not used yet")).toBeTruthy();

    const link = screen.getByRole("link", { name: "acme.service-now.com" });
    expect(link.getAttribute("href")).toBe("https://acme.service-now.com");
    expect(link.getAttribute("rel")).toBe("noreferrer noopener");

    expect(screen.getByRole("button", { name: "Delete the syncs that use this connection first" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Delete Acme staging" })).toHaveProperty("disabled", false);
    expect(screen.getByText("What the ServiceNow account needs")).toBeTruthy();
    expect(screen.getByText("snc_platform_rest_api_access")).toBeTruthy();
  });

  it("tests connections and reports the outcome", async () => {
    let attempt = 0;
    setup({
      "POST /api/connections/:id/test": (_call, params) => {
        attempt += 1;
        if (attempt === 3) return { status: 504, body: errorBody("SN_UNREACHABLE", "No answer.", { title: "ServiceNow is unreachable" }) };
        const base = params.id === STAGING_ID ? staging : production;
        return { body: { connection: { ...base, status: attempt === 1 ? "ok" : "error", statusMessage: attempt === 1 ? null : "The account lacks the knowledge role." } } };
      },
    });
    await screen.findByText("Acme production");
    const [testProduction, testStaging] = screen.getAllByRole("button", { name: "Test" });

    fireEvent.click(testStaging!);
    expect(await screen.findByText("Connection works")).toBeTruthy();
    expect(screen.getByText("Acme staging can read knowledge.")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("Can't connect")).toBeNull());

    fireEvent.click(testProduction!);
    expect(await screen.findByText("Connection test failed")).toBeTruthy();
    expect(screen.getAllByText("The account lacks the knowledge role.").length).toBeGreaterThan(0);

    fireEvent.click(testProduction!);
    expect(await screen.findByText("ServiceNow is unreachable")).toBeTruthy();
  });

  it("adds a connection after testing it", async () => {
    const created: ConnectionDTO = makeConnection({ id: "44444444-4444-4444-8444-444444444444", name: "Acme EU", instanceUrl: "https://acme-eu.service-now.com", principal: "svc_eu" });
    const api = setup({ "POST /api/connections": { status: 201, body: { connection: created } } });
    fireEvent.click(await screen.findByRole("button", { name: "Add ServiceNow connection" }));
    expect(dialog().getByText("Connect ServiceNow")).toBeTruthy();
    expect(dialog().getByText("A ServiceNow integration user with basic authentication.")).toBeTruthy();

    fireEvent.change(dialog().getByLabelText("Name"), { target: { value: " Acme EU " } });
    fireEvent.change(dialog().getByLabelText("Instance"), { target: { value: "acme-eu" } });
    fireEvent.change(dialog().getByLabelText("Username"), { target: { value: "svc_eu" } });
    fireEvent.change(dialog().getByLabelText("Password"), { target: { value: "not-a-real-password" } });
    await act(async () => fireEvent.click(dialog().getByRole("button", { name: "Test and connect" })));

    expect(await screen.findByText("ServiceNow connected")).toBeTruthy();
    expect(api.callsTo("POST", "/api/connections")[0]?.body).toEqual({ name: "Acme EU", instanceUrl: "acme-eu", auth: { type: "basic", username: "svc_eu", password: "not-a-real-password" } });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText("Acme EU")).toBeTruthy();
  });

  it("shows field errors and general errors inside the dialog", async () => {
    let attempt = 0;
    setup({
      "POST /api/connections": () => {
        attempt += 1;
        return attempt === 1
          ? { status: 422, body: errorBody("VALIDATION", "Check the fields.", { fields: [{ path: "instanceUrl", message: "Enter a ServiceNow instance." }, { path: "auth.password", message: "Enter the password." }] }) }
          : { status: 400, body: errorBody("SN_AUTH_FAILED", "ServiceNow didn't accept the username or password.", { title: "ServiceNow rejected the credentials" }) };
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Add ServiceNow connection" }));
    await act(async () => fireEvent.click(dialog().getByRole("button", { name: "Test and connect" })));
    expect(await screen.findByText("Enter a ServiceNow instance.")).toBeTruthy();
    expect(dialog().getByText("Enter the password.")).toBeTruthy();
    expect(dialog().getByLabelText("Instance").getAttribute("aria-invalid")).toBe("true");

    await act(async () => fireEvent.click(dialog().getByRole("button", { name: "Test and connect" })));
    expect(await screen.findByText("ServiceNow rejected the credentials")).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();

    fireEvent.click(dialog().getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("edits a connection and keeps the saved secret when left blank", async () => {
    const api = setup({ "PUT /api/connections/:id": (call) => ({ body: { connection: { ...production, name: (call.body as { name: string }).name } } }) });
    fireEvent.click(await screen.findByRole("button", { name: "Edit Acme production" }));
    expect(dialog().getByText("Edit ServiceNow connection")).toBeTruthy();
    expect((dialog().getByLabelText("Username") as HTMLInputElement).value).toBe("svc_knowledge");
    expect(dialog().getByText("Leave blank to keep the saved value.")).toBeTruthy();
    expect(dialog().getByLabelText("Password").getAttribute("placeholder")).toBe("••••••••");

    fireEvent.change(dialog().getByLabelText("Name"), { target: { value: "Acme prod" } });
    await act(async () => fireEvent.click(dialog().getByRole("button", { name: "Test and save" })));
    expect(await screen.findByText("Connection updated")).toBeTruthy();
    expect(api.callsTo("PUT", `/api/connections/${CONNECTION_ID}`)[0]?.body).toEqual({ name: "Acme prod", instanceUrl: "https://acme.service-now.com", auth: { type: "basic", username: "svc_knowledge" } });
    expect(await screen.findByText("Acme prod")).toBeTruthy();
  });

  it("asks for a new secret when the authentication type changes", async () => {
    const api = setup({ "PUT /api/connections/:id": { body: { connection: { ...staging, authType: "apikey", principal: null, status: "ok", statusMessage: null } } } });
    fireEvent.click(await screen.findByRole("button", { name: "Edit Acme staging" }));
    expect((dialog().getByLabelText("Client ID") as HTMLInputElement).value).toBe("client-abc");
    expect(dialog().getByText("Leave blank to keep the saved value.")).toBeTruthy();

    fireEvent.click(dialog().getByRole("radio", { name: /API key/ }));
    expect(dialog().getByText("Sent in the x-sn-apikey header.")).toBeTruthy();
    expect(dialog().queryByText("Leave blank to keep the saved value.")).toBeNull();
    fireEvent.change(dialog().getByLabelText("API key"), { target: { value: "not-a-real-api-key" } });
    await act(async () => fireEvent.click(dialog().getByRole("button", { name: "Test and save" })));
    expect(await screen.findByText("Connection updated")).toBeTruthy();
    expect((api.callsTo("PUT", `/api/connections/${STAGING_ID}`)[0]?.body as { auth: unknown }).auth).toEqual({ type: "apikey", apiKey: "not-a-real-api-key" });

    fireEvent.click(screen.getByRole("button", { name: "Edit Acme staging" }));
    fireEvent.click(dialog().getByRole("radio", { name: /OAuth client/ }));
    expect((dialog().getByLabelText("Client ID") as HTMLInputElement).value).toBe("");
    fireEvent.click(dialog().getByRole("radio", { name: /Username & password/ }));
    expect(dialog().getByLabelText("Password").getAttribute("placeholder")).toBe("");
  });

  it("deletes an unused connection after confirmation", async () => {
    const api = setup({ "DELETE /api/connections/:id": { status: 204 } });
    fireEvent.click(await screen.findByRole("button", { name: "Delete Acme staging" }));
    expect(dialog().getByText("Delete Acme staging?")).toBeTruthy();
    api.set("GET /api/connections", { body: { connections: [production] } });
    await act(async () => fireEvent.click(dialog().getByRole("button", { name: "Delete connection" })));
    expect(await screen.findByText("Connection deleted")).toBeTruthy();
    expect(api.callsTo("DELETE", `/api/connections/${STAGING_ID}`)).toHaveLength(1);
    await waitFor(() => expect(screen.queryByText("Acme staging")).toBeNull());
  });

  it("keeps the delete dialog open when deletion fails", async () => {
    setup({ "DELETE /api/connections/:id": { status: 409, body: errorBody("CONNECTION_IN_USE", "A sync uses it.", { title: "Connection in use" }) } });
    fireEvent.click(await screen.findByRole("button", { name: "Delete Acme staging" }));
    await act(async () => fireEvent.click(dialog().getByRole("button", { name: "Delete connection" })));
    expect(await screen.findByText("Connection in use")).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("invites the first connection", async () => {
    setup({ "GET /api/connections": { body: { connections: [] } } });
    expect(await screen.findByText("No ServiceNow instance yet")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Connect ServiceNow" }));
    expect(dialog().getByText("Connect ServiceNow", { selector: "h2" })).toBeTruthy();
  });

  it("retries when connections fail to load", async () => {
    const api = setup({ "GET /api/connections": { status: 500, body: errorBody("INTERNAL", "Broken.", { title: "Couldn't load connections" }) } });
    expect(await screen.findByText("Couldn't load connections")).toBeTruthy();
    api.set("GET /api/connections", { body: { connections: [production] } });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Acme production")).toBeTruthy();
  });
});

describe("Genesys Cloud sync credentials", () => {
  it("guides the first setup and verifies the client before saving", async () => {
    const api = setup({
      "GET /api/genesys/credentials": { body: { credentials: makeCredentials({ status: "missing", clientId: null, verifiedAt: null }) } },
      "PUT /api/genesys/credentials": { body: { credentials: makeCredentials({ clientId: "9a8b7c6d-0000-4000-8000-000000000002" }) } },
    });
    expect(await genesysCard().findByText("Not set up")).toBeTruthy();
    expect(genesysCard().getByText("knowledge:synchronization:upload")).toBeTruthy();
    expect(genesysCard().getByText("optional")).toBeTruthy();

    await act(async () => fireEvent.click(genesysCard().getByRole("button", { name: "Copy required permissions" })));
    const copied = String(vi.mocked(navigator.clipboard.writeText).mock.calls[0]?.[0]);
    expect(copied.split("\n")).toHaveLength(7);
    expect(copied).not.toContain("sourceFileCount");

    const save = genesysCard().getByRole("button", { name: "Verify and save" });
    expect(save).toHaveProperty("disabled", true);
    fireEvent.change(genesysCard().getByLabelText("Client ID"), { target: { value: " 9a8b7c6d-0000-4000-8000-000000000002 " } });
    fireEvent.change(genesysCard().getByLabelText("Client secret"), { target: { value: "not-a-real-secret" } });
    expect(save).toHaveProperty("disabled", false);
    await act(async () => fireEvent.click(save));

    expect(await screen.findByText("Genesys Cloud credentials saved")).toBeTruthy();
    expect(api.callsTo("PUT", "/api/genesys/credentials")[0]?.body).toEqual({ clientId: "9a8b7c6d-0000-4000-8000-000000000002", clientSecret: "not-a-real-secret" });
    expect(genesysCard().getByText("Connected")).toBeTruthy();
    expect(genesysCard().getByText("9a8b7c6d-0000-4000-8000-000000000002")).toBeTruthy();
    expect(genesysCard().getByText("Last verified")).toBeTruthy();
  });

  it("replaces working credentials, or cancels", async () => {
    setup();
    fireEvent.click(await genesysCard().findByRole("button", { name: "Replace" }));
    expect(genesysCard().getByLabelText("Client ID")).toBeTruthy();
    fireEvent.click(genesysCard().getByRole("button", { name: "Cancel" }));
    expect(genesysCard().queryByLabelText("Client ID")).toBeNull();
    expect(genesysCard().getByRole("button", { name: "Replace" })).toBeTruthy();
  });

  it("explains credentials that stopped working", async () => {
    setup({ "GET /api/genesys/credentials": { body: { credentials: makeCredentials({ status: "error", message: "The OAuth client was deleted." }) } } });
    expect(await genesysCard().findByText("Not working")).toBeTruthy();
    expect(genesysCard().getByText("These credentials stopped working")).toBeTruthy();
    expect(genesysCard().getByText("The OAuth client was deleted.")).toBeTruthy();
    expect(genesysCard().getByText("Last checked")).toBeTruthy();
  });

  it("shows field and general errors from verification", async () => {
    let attempt = 0;
    setup({
      "GET /api/genesys/credentials": { body: { credentials: makeCredentials({ status: "missing", clientId: null, verifiedAt: null }) } },
      "PUT /api/genesys/credentials": () => {
        attempt += 1;
        return attempt === 1
          ? { status: 422, body: errorBody("VALIDATION", "Check the fields.", { fields: [{ path: "clientId", message: "Enter the client ID as a GUID." }] }) }
          : { status: 403, body: errorBody("GC_ORG_MISMATCH", "The client belongs to another organization.", { title: "Wrong organization" }) };
      },
    });
    await genesysCard().findByText("Not set up");
    fireEvent.change(genesysCard().getByLabelText("Client ID"), { target: { value: "not-a-guid" } });
    fireEvent.change(genesysCard().getByLabelText("Client secret"), { target: { value: "not-a-real-secret" } });
    await act(async () => fireEvent.click(genesysCard().getByRole("button", { name: "Verify and save" })));
    expect(await genesysCard().findByText("Enter the client ID as a GUID.")).toBeTruthy();

    await act(async () => fireEvent.click(genesysCard().getByRole("button", { name: "Verify and save" })));
    expect(await genesysCard().findByText("Wrong organization")).toBeTruthy();
  });

  it("removes credentials after confirmation", async () => {
    let attempt = 0;
    setup({
      "DELETE /api/genesys/credentials": () => {
        attempt += 1;
        return attempt === 1
          ? { status: 500, body: errorBody("INTERNAL", "Broken.", { title: "Couldn't remove" }) }
          : { body: { credentials: makeCredentials({ status: "missing", clientId: null, verifiedAt: null }) } };
      },
    });
    fireEvent.click(await genesysCard().findByRole("button", { name: "Remove" }));
    expect(dialog().getByText("Remove Genesys Cloud credentials?")).toBeTruthy();
    await act(async () => fireEvent.click(dialog().getByRole("button", { name: "Remove credentials" })));
    expect(await screen.findByText("Couldn't remove")).toBeTruthy();

    await act(async () => fireEvent.click(dialog().getByRole("button", { name: "Remove credentials" })));
    expect(await screen.findByText("Credentials removed")).toBeTruthy();
    expect(genesysCard().getByText("Not set up")).toBeTruthy();
  });

  it("shows a load error", async () => {
    setup({ "GET /api/genesys/credentials": { status: 500, body: errorBody("INTERNAL", "Broken.", { title: "Couldn't load credentials" }) } });
    expect(await genesysCard().findByText("Couldn't load credentials")).toBeTruthy();
  });
});