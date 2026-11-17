import { ArrowLeft } from "lucide-react";
import { GenesysLogo } from "@/components/brand";
import { ButtonLink } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col bg-nimbus px-6 py-8">
      <GenesysLogo width={108} />
      <div className="m-auto max-w-md text-center">
        <div className="bg-gen-gradient mx-auto grid size-28 place-items-center rounded-full">
          <span className="text-4xl font-light tracking-tight text-navy">404</span>
        </div>
        <h1 className="mt-6 text-2xl font-semibold tracking-tight text-navy">We couldn&apos;t find that page</h1>
        <p className="mt-2 text-sm leading-relaxed text-navy/60">The link may be out of date, or the sync was deleted.</p>
        <ButtonLink href="/" variant="primary" className="mt-7" icon={<ArrowLeft className="size-4" aria-hidden />}>
          Back to your syncs
        </ButtonLink>
      </div>
    </div>
  );
}
