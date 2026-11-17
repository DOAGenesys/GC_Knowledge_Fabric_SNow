import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SyncDetail } from "@/components/syncs/sync-detail";

export const metadata: Metadata = { title: "Sync" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function SyncPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  return <SyncDetail id={id} />;
}
