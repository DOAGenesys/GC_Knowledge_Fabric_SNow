import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { StatusBadge, Chip } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { Callout, ErrorCallout } from "@/components/ui/callout";
import { Card, CardHeader, SectionTitle } from "@/components/ui/card";
import { CopyButton } from "@/components/ui/copy-button";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { EmptyState, ProgressBar, Skeleton } from "@/components/ui/feedback";
import { Checkbox, ChoiceCards, Field, Input, Select, Switch, Textarea } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { TabPanel, Tabs } from "@/components/ui/tabs";
import { ToastProvider, useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api-client";

const apiError = (overrides: Partial<ConstructorParameters<typeof ApiError>[0]> = {}) =>
  new ApiError({ status: 502, code: "SN_UNREACHABLE", title: "ServiceNow is unreachable", message: "The instance didn't answer.", hint: "Check the instance URL.", requestId: "req-7", ...overrides });

describe("Button", () => {
  it("shows a spinner and blocks clicks while loading", () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Save
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Save" });
    expect(button).toHaveProperty("disabled", true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.querySelector("svg")).not.toBeNull();
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("renders links styled as buttons", () => {
    render(
      <ButtonLink href="/syncs/new" variant="primary" size="lg">
        New sync
      </ButtonLink>,
    );
    const link = screen.getByRole("link", { name: "New sync" });
    expect(link.getAttribute("href")).toBe("/syncs/new");
    expect(link.className).toContain("bg-brand");
  });
});

describe("form fields", () => {
  it("wires labels, hints and errors for assistive tech", () => {
    const { rerender } = render(
      <Field label="Name" hint="Shown in lists." optional>
        {(props) => <Input {...props} defaultValue="" />}
      </Field>,
    );
    const input = screen.getByLabelText(/Name/);
    expect(screen.getByText("Optional")).toBeTruthy();
    expect(document.getElementById(input.getAttribute("aria-describedby") ?? "")?.textContent).toBe("Shown in lists.");

    rerender(
      <Field label="Name" hint="Shown in lists." error="Required">
        {(props) => <Input {...props} defaultValue="" />}
      </Field>,
    );
    const invalid = screen.getByLabelText(/Name/);
    expect(invalid.getAttribute("aria-invalid")).toBe("true");
    expect(screen.queryByText("Shown in lists.")).toBeNull();
    expect(screen.getByText("Required")).toBeTruthy();
  });

  it("renders select and textarea controls", () => {
    render(
      <>
        <Select aria-label="Region" defaultValue="b">
          <option value="a">A</option>
          <option value="b">B</option>
        </Select>
        <Textarea aria-label="Query" defaultValue="active=true" />
      </>,
    );
    expect((screen.getByLabelText("Region") as HTMLSelectElement).value).toBe("b");
    expect((screen.getByLabelText("Query") as HTMLTextAreaElement).value).toBe("active=true");
  });

  it("toggles a switch", () => {
    function Harness() {
      const [checked, setChecked] = useState(false);
      return <Switch checked={checked} onChange={setChecked} label="Automatic syncs" description="Runs on schedule" />;
    }
    render(<Harness />);
    const toggle = screen.getByRole("switch");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("Runs on schedule")).toBeTruthy();
  });

  it("selects choice cards and skips disabled ones", () => {
    const onChange = vi.fn();
    render(
      <ChoiceCards
        name="kind"
        label="Kind"
        columns={4}
        value="a"
        onChange={onChange}
        options={[
          { value: "a", label: "Alpha" },
          { value: "b", label: "Beta", description: "Second" },
          { value: "c", label: "Gamma", disabled: true },
        ]}
      />,
    );
    expect(screen.getByRole("radiogroup", { name: "Kind" }).className).toContain("grid-cols-2");
    fireEvent.click(screen.getByLabelText(/Beta/));
    expect(onChange).toHaveBeenCalledWith("b");
    expect((screen.getByLabelText(/Gamma/) as HTMLInputElement).disabled).toBe(true);
  });

  it("renders a described checkbox", () => {
    const onChange = vi.fn();
    render(<Checkbox label="Run now" description="Starts right away" checked={false} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText(/Run now/));
    expect(onChange).toHaveBeenCalled();
  });
});

describe("callouts", () => {
  it("uses alert semantics only for danger", () => {
    render(
      <>
        <Callout tone="danger" title="Broken" action={<button type="button">Fix</button>}>
          Details
        </Callout>
        <Callout tone="success">All good</Callout>
      </>,
    );
    expect(screen.getByRole("alert").textContent).toContain("Broken");
    expect(screen.getByRole("status").textContent).toContain("All good");
    expect(screen.getByRole("button", { name: "Fix" })).toBeTruthy();
  });

  it("explains API errors with hint and a copyable request ID", async () => {
    render(<ErrorCallout error={apiError()} />);
    expect(screen.getByText("ServiceNow is unreachable")).toBeTruthy();
    expect(screen.getByText("The instance didn't answer.")).toBeTruthy();
    expect(screen.getByText("Check the instance URL.")).toBeTruthy();
    expect(screen.getByText("req-7")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy request ID" })));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("req-7");
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("falls back to a generic message for unknown errors", () => {
    render(<ErrorCallout error={new Error("raw internal detail")} tone="warning" />);
    expect(screen.getByText("Something went wrong")).toBeTruthy();
    expect(screen.queryByText(/raw internal detail/)).toBeNull();
  });
});

describe("CopyButton", () => {
  it("resets after a moment and survives clipboard failures", async () => {
    vi.useFakeTimers();
    render(<CopyButton value="abc" label="Copy ID" />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy ID" })));
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
    act(() => vi.advanceTimersByTime(1_700));
    expect(screen.getByRole("button", { name: "Copy ID" })).toBeTruthy();

    vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error("denied"));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy ID" })));
    expect(screen.getByRole("button", { name: "Copy ID" })).toBeTruthy();
  });
});

describe("Dialog", () => {
  it("opens modally and closes from the button, Escape and the backdrop", () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <Dialog open onClose={onClose} title="Edit" description="Change things" footer={<button type="button">Save</button>}>
        <p>Body</p>
      </Dialog>,
    );
    const dialog = document.querySelector("dialog")!;
    expect(dialog.open).toBe(true);
    expect(screen.getByText("Body")).toBeTruthy();
    expect(screen.getByText("Change things")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    fireEvent.click(dialog);
    expect(onClose).toHaveBeenCalledTimes(3);

    rerender(
      <Dialog open={false} onClose={onClose} title="Edit">
        <p>Body</p>
      </Dialog>,
    );
    expect(dialog.open).toBe(false);
    expect(screen.queryByText("Body")).toBeNull();
  });

  it("confirm dialogs close on success and stay open on failure", async () => {
    const onClose = vi.fn();
    const onConfirm = vi.fn().mockRejectedValueOnce(new Error("nope")).mockResolvedValueOnce(undefined);
    render(
      <ConfirmDialog open onClose={onClose} onConfirm={onConfirm} title="Delete?" confirmLabel="Delete" tone="danger">
        <p>Gone for good.</p>
      </ConfirmDialog>,
    );
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Delete" })));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Delete" })));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

function ToastHarness({ action }: { action: (toast: ReturnType<typeof useToast>) => void }) {
  const toast = useToast();
  return (
    <button type="button" onClick={() => action(toast)}>
      Fire
    </button>
  );
}

describe("toasts", () => {
  it("shows success, info and API error toasts", () => {
    render(
      <ToastProvider>
        <ToastHarness
          action={(toast) => {
            toast.success("Saved", "All set.");
            toast.info("Heads up");
            toast.error(apiError());
          }}
        />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Fire" }));
    expect(screen.getAllByRole("status").map((node) => node.textContent)).toEqual(["SavedAll set.", "Heads up"]);
    expect(screen.getByRole("alert").textContent).toBe("ServiceNow is unreachableThe instance didn't answer. Check the instance URL.");
  });

  it("skips expired-session errors, falls back for unknown errors and deduplicates", () => {
    render(
      <ToastProvider>
        <ToastHarness
          action={(toast) => {
            toast.error(apiError({ status: 401, code: "UNAUTHENTICATED", title: "Signed out" }));
            toast.error(new Error("x"), "Couldn't save");
            toast.error(new Error("y"), "Couldn't save");
          }}
        />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Fire" }));
    expect(screen.queryByText("Signed out")).toBeNull();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByText("Please try again in a moment.")).toBeTruthy();
  });

  it("keeps at most four toasts and dismisses them over time", () => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <ToastHarness
          action={(toast) => {
            for (let index = 1; index <= 6; index++) toast.success(`Toast ${index}`);
          }}
        />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Fire" }));
    expect(screen.getAllByRole("status").map((node) => node.textContent)).toEqual(["Toast 3", "Toast 4", "Toast 5", "Toast 6"]);
    fireEvent.click(screen.getAllByRole("button", { name: "Dismiss" })[0]!);
    expect(screen.getAllByRole("status")).toHaveLength(3);
    act(() => vi.advanceTimersByTime(5_100));
    expect(screen.queryAllByRole("status")).toHaveLength(0);
  });

  it("must be used inside the provider", () => {
    vi.mocked(console.error).mockImplementation(() => undefined);
    expect(() => render(<ToastHarness action={() => undefined} />)).toThrow("useToast must be used inside <ToastProvider>");
  });
});

describe("Tabs", () => {
  it("switches with clicks and arrow keys, wrapping around", () => {
    function Harness() {
      const [tab, setTab] = useState<"a" | "b" | "c">("a");
      return (
        <>
          <Tabs
            label="Sections"
            value={tab}
            onChange={setTab}
            tabs={[
              { id: "a", label: "Activity" },
              { id: "b", label: "Articles", count: 12 },
              { id: "c", label: "Settings", count: 2, attention: true },
            ]}
          />
          <TabPanel id={tab}>Panel {tab}</TabPanel>
        </>
      );
    }
    render(<Harness />);
    const tablist = screen.getByRole("tablist", { name: "Sections" });
    expect(screen.getByRole("tab", { name: /Articles/ }).textContent).toBe("Articles12");
    expect(screen.getByText("2").className).toContain("text-danger");

    fireEvent.keyDown(tablist, { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: /Settings/ }).getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement?.id).toBe("tab-c");
    fireEvent.keyDown(tablist, { key: "ArrowRight" });
    expect(screen.getByRole("tabpanel").textContent).toBe("Panel a");
    fireEvent.keyDown(tablist, { key: "Enter" });
    fireEvent.click(screen.getByRole("tab", { name: /Articles/ }));
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe("tab-b");
  });
});

describe("feedback and layout", () => {
  it("reports progress values, clamped", () => {
    render(
      <>
        <ProgressBar value={0.42} label="Uploading" />
        <ProgressBar value={1.7} tone="patina" label="Done" />
        <ProgressBar value={null} tone="danger" label="Indexing" />
      </>,
    );
    expect(screen.getByRole("progressbar", { name: "Uploading" }).getAttribute("aria-valuenow")).toBe("42");
    expect(screen.getByRole("progressbar", { name: "Done" }).getAttribute("aria-valuenow")).toBe("100");
    expect(screen.getByRole("progressbar", { name: "Indexing" }).hasAttribute("aria-valuenow")).toBe(false);
  });

  it("renders empty states, cards, badges and skeletons", () => {
    const { container } = render(
      <Card>
        <CardHeader title="Card title" description="Card description" action={<span>Action</span>} />
        <SectionTitle>Section</SectionTitle>
        <EmptyState illustration="/brand/icon-search.svg" title="Nothing here" action={<button type="button">Create</button>}>
          Add something.
        </EmptyState>
        <StatusBadge tone="active" size="sm">
          Syncing
        </StatusBadge>
        <Chip icon={<span>i</span>}>CSM</Chip>
        <Skeleton className="h-4" />
        <Spinner />
      </Card>,
    );
    expect(screen.getByText("Card title")).toBeTruthy();
    expect(screen.getByText("Card description")).toBeTruthy();
    expect(screen.getByText("Nothing here")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create" })).toBeTruthy();
    expect(screen.getByText("Syncing").className).toContain("text-[11px]");
    expect(container.querySelector(".skeleton")?.getAttribute("aria-hidden")).toBe("true");
  });
});
