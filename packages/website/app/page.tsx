import { Button } from "@vercel/geistdocs/components/button";
import Link from "next/link";
import { getFeaturedDocs } from "@/lib/docs";

const docsUrl = "/docs";

const comparison = [
  {
    label: "Scope",
    review: "Changed files",
    deepsec: "Every file in the repo",
  },
  {
    label: "Context",
    review: "Diff plus comments",
    deepsec: "Source, framework, INFO.md",
  },
  {
    label: "Cadence",
    review: "At merge time",
    deepsec: "Whenever you run it",
  },
];

const reasons = [
  {
    title: "PR tools only see the diff",
    body: "A review bot reads what changed this week. Vulnerabilities usually live in old handlers, configuration, background jobs, and integrations that nobody has touched in months.",
  },
  {
    title: "Models got better",
    body: "Code that passed review a year ago was reviewed with the models of a year ago. Reading it again with today's models, and with more of the repo in context, finds bugs the first pass missed.",
  },
  {
    title: "Reading source beats probing",
    body: "A pentest starts outside the system and guesses at what is behind each endpoint. deepsec reads the route definitions, the auth middleware, the dependencies, and your notes about how the project works.",
  },
];

const workflow = [
  {
    label: "scan",
    title: "Index the repository",
    body: "Regex matchers and framework detection locate routes, server actions, jobs, RPC surfaces, and infrastructure files. No model is involved yet, so this step is fast and free.",
  },
  {
    label: "process",
    title: "Investigate with an agent",
    body: "Claude, Codex, or Pi reads each batch of candidate files along with the surrounding source and your project notes from INFO.md, then writes up findings with severity and a recommendation.",
  },
  {
    label: "revalidate",
    title: "Recheck the findings",
    body: "High-severity findings get a second, independent pass against the source and git history before anyone is asked to act on them. This cuts the false positive rate.",
  },
  {
    label: "export",
    title: "Hand off the results",
    body: "Export markdown or JSON for AppSec review, tickets, CI, or a follow-up agent that writes the patches.",
  },
];

const useCases = [
  {
    title: "Backlog audit",
    tag: "Full repo",
    body: "Run a full scan before a launch, after a model upgrade, or as part of a security review cycle.",
  },
  {
    title: "PR gate",
    tag: "Diff mode",
    body: "process --diff investigates only the files a pull request touches and can fail CI when new findings appear. Full-repo and diff findings live in the same state.",
  },
  {
    title: "Custom surfaces",
    tag: "Matchers",
    body: "Write matchers for internal RPC, auth wrappers, and webhook conventions, so the scan covers the parts of your stack a generic scanner does not recognize.",
  },
  {
    title: "Large repos",
    tag: "Resumable",
    body: "Runs are append-only and can fan out across Vercel Sandbox microVMs. If a run stops on quota or an error, run the same command again and deepsec skips the files it already analyzed.",
  },
];

const tech = [
  "Next.js",
  "React",
  "Express",
  "FastAPI",
  "Django",
  "Flask",
  "Laravel",
  "Rails",
  "Gin",
  "Echo",
  "Terraform",
  "GitHub Actions",
];

export default function Home() {
  const docs = getFeaturedDocs();

  return (
    <div className="min-h-screen bg-background-100 text-gray-1000">
      <main>
        <section className="hero-grid border-b border-gray-alpha-400">
          <div className="mx-auto flex w-full max-w-7xl flex-col px-4 pb-12 pt-16 sm:px-6 sm:pb-16 sm:pt-24 lg:px-8">
            <div className="mx-auto flex max-w-4xl flex-col items-center text-center">
              <div className="mb-6 inline-flex max-w-full items-center border border-gray-alpha-400 bg-background-100 px-3 py-1.5 text-center text-sm leading-5 text-gray-900">
                Open source vulnerability scanner for large code bases
              </div>
              <h1 className="max-w-4xl text-5xl font-semibold leading-none text-gray-1000 sm:text-7xl lg:text-8xl">
                Find the vulnerabilities that already shipped.
              </h1>
              <p className="mt-7 max-w-2xl text-lg leading-8 text-gray-900 sm:text-xl sm:leading-9">
                deepsec runs coding agents over your entire repository, in your own infrastructure.
                It reads old routes, background jobs, internal APIs, and everything else that merged
                before today&apos;s models existed and that pull request review will never look at
                again.
              </p>
              <div
                id="get-started"
                className="mt-8 flex w-full max-w-2xl flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-center"
              >
                <Button asChild className="w-full shadow-none sm:w-auto" size="lg">
                  <a href="#docs">Start a scan</a>
                </Button>
                <Button
                  asChild
                  className="w-full shadow-none sm:w-auto"
                  size="lg"
                  variant="outline"
                >
                  <Link href={docsUrl}>Read the docs</Link>
                </Button>
              </div>
            </div>

            <div className="mx-auto mt-14 w-full max-w-5xl overflow-hidden border border-gray-alpha-400 bg-background-100 [box-shadow:var(--ds-shadow-modal)]">
              <div className="flex min-h-10 items-center justify-between border-b border-gray-alpha-400 px-4">
                <div className="flex items-center gap-2">
                  <span className="size-2 bg-[#ff5f57]" />
                  <span className="size-2 bg-[#ffbd2e]" />
                  <span className="size-2 bg-[#28c840]" />
                </div>
                <p className="font-mono text-xs text-gray-800">.deepsec/run</p>
              </div>
              <div className="grid min-w-0 lg:grid-cols-[1.08fr_0.92fr]">
                <div className="min-w-0 border-b border-gray-alpha-400 p-5 sm:p-6 lg:border-b-0 lg:border-r">
                  <pre className="max-w-full overflow-x-auto font-mono text-sm leading-7 text-gray-950">
                    <code>{`$ npx deepsec init
$ pnpm deepsec scan
✓ indexed source, config, routes, jobs
✓ detected nextjs, express, prisma, github-actions

$ pnpm deepsec process --concurrency 5
batch 014  HIGH  admin route bypass
batch 018  HIGH  tenant cache leak
batch 021  MED   webhook replay window

$ pnpm deepsec revalidate --min-severity HIGH
✓ confirmed against source and history
✓ exported findings for review`}</code>
                  </pre>
                </div>
                <div className="grid grid-rows-[auto_1fr]">
                  <div className="border-b border-gray-alpha-400 p-5 sm:p-6">
                    <p className="text-sm font-medium text-gray-1000">Why it finds more</p>
                    <p className="mt-3 text-sm leading-6 text-gray-900">
                      The model reads your actual source, your framework structure, and your notes
                      about the project. An external pentest starts with none of that.
                    </p>
                  </div>
                  <div className="p-5 sm:p-6">
                    <div className="grid grid-cols-[0.8fr_1fr_1fr] border border-gray-alpha-400 text-sm">
                      <div className="border-b border-r border-gray-alpha-400 bg-background-200 p-3 font-mono text-xs text-gray-800">
                        Signal
                      </div>
                      <div className="border-b border-r border-gray-alpha-400 bg-background-200 p-3 font-mono text-xs text-gray-800">
                        PR review
                      </div>
                      <div className="border-b border-gray-alpha-400 bg-background-200 p-3 font-mono text-xs text-gray-800">
                        deepsec
                      </div>
                      {comparison.map((item) => (
                        <ComparisonRow key={item.label} item={item} />
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section id="why" className="border-b border-gray-alpha-400">
          <div className="mx-auto w-full max-w-7xl px-4 py-16 sm:px-6 lg:px-8 lg:py-24">
            <div className="max-w-2xl">
              <p className="text-sm font-medium text-gray-800">Why full-repo review</p>
              <h2 className="mt-3 text-3xl font-semibold leading-tight sm:text-5xl">
                Most security debt is already merged.
              </h2>
            </div>
            <div className="mt-10 grid gap-px border border-gray-alpha-400 bg-gray-alpha-400 md:grid-cols-3">
              {reasons.map((reason) => (
                <article key={reason.title} className="bg-background-100 p-6">
                  <h3 className="text-xl font-semibold">{reason.title}</h3>
                  <p className="mt-4 text-sm leading-6 text-gray-900">{reason.body}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section id="workflow" className="border-b border-gray-alpha-400 bg-background-200">
          <div className="mx-auto grid w-full max-w-7xl gap-10 px-4 py-16 sm:px-6 lg:grid-cols-[0.72fr_1fr] lg:px-8 lg:py-24">
            <div>
              <p className="text-sm font-medium text-gray-800">How it works</p>
              <h2 className="mt-3 max-w-md text-3xl font-semibold leading-tight sm:text-5xl">
                Four commands from checkout to confirmed findings.
              </h2>
              <p className="mt-5 max-w-md text-base leading-7 text-gray-900">
                Cheap regex indexing decides where the models look, so the expensive agent time goes
                to code that can actually be vulnerable. Important findings are rechecked before
                they leave the tool.
              </p>
            </div>
            <div className="grid gap-px border border-gray-alpha-400 bg-gray-alpha-400 sm:grid-cols-2">
              {workflow.map((step, index) => (
                <article key={step.label} className="bg-background-100 p-6">
                  <div className="flex items-center justify-between">
                    <p className="font-mono text-sm text-gray-800">{step.label}</p>
                    <span className="font-mono text-xs text-gray-700">0{index + 1}</span>
                  </div>
                  <h3 className="mt-10 text-xl font-semibold">{step.title}</h3>
                  <p className="mt-3 text-sm leading-6 text-gray-900">{step.body}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section id="fit" className="border-b border-gray-alpha-400">
          <div className="mx-auto w-full max-w-7xl px-4 py-16 sm:px-6 lg:px-8 lg:py-24">
            <div className="max-w-2xl">
              <p className="text-sm font-medium text-gray-800">Ways to run it</p>
              <h2 className="mt-3 text-3xl font-semibold leading-tight sm:text-5xl">
                One-off audit, CI gate, or a standing review of a monorepo.
              </h2>
            </div>
            <div className="mt-10 grid gap-px border border-gray-alpha-400 bg-gray-alpha-400 md:grid-cols-2 lg:grid-cols-4">
              {useCases.map((item) => (
                <article key={item.title} className="bg-background-100 p-6">
                  <p className="font-mono text-xs text-gray-800">{item.tag}</p>
                  <h3 className="mt-10 text-lg font-semibold">{item.title}</h3>
                  <p className="mt-3 text-sm leading-6 text-gray-900">{item.body}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section id="coverage" className="border-b border-gray-alpha-400 bg-background-200">
          <div className="mx-auto grid w-full max-w-7xl gap-10 px-4 py-16 sm:px-6 lg:grid-cols-[0.9fr_1.1fr] lg:px-8 lg:py-24">
            <div>
              <p className="text-sm font-medium text-gray-800">Source context</p>
              <h2 className="mt-3 text-3xl font-semibold leading-tight sm:text-5xl">
                Built-in coverage for common frameworks.
              </h2>
              <p className="mt-5 max-w-lg text-base leading-7 text-gray-900">
                deepsec ships with matchers for the entry points of common web frameworks and
                infrastructure files, and sends the model small batches of related files with
                project context attached. If your stack has internal conventions, you can add your
                own matchers instead of waiting for a generic scanner to learn them.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-px border border-gray-alpha-400 bg-gray-alpha-400 sm:grid-cols-3">
              {tech.map((item) => (
                <div
                  key={item}
                  className="flex h-24 items-center justify-center bg-background-100 px-4 text-center text-sm font-medium text-gray-950"
                >
                  {item}
                </div>
              ))}
              <div className="flex h-24 items-center justify-center bg-gray-1000 px-4 text-center text-sm font-medium text-background-100">
                Your matchers
              </div>
              <div className="flex h-24 items-center justify-center bg-background-100 px-4 text-center text-sm font-medium text-gray-950">
                Internal RPC
              </div>
              <div className="flex h-24 items-center justify-center bg-background-100 px-4 text-center text-sm font-medium text-gray-950">
                Webhooks
              </div>
            </div>
          </div>
        </section>

        <section id="docs" className="border-b border-gray-alpha-400">
          <div className="mx-auto w-full max-w-7xl px-4 py-16 sm:px-6 lg:px-8 lg:py-24">
            <div className="flex flex-col justify-between gap-6 md:flex-row md:items-end">
              <div className="max-w-2xl">
                <p className="text-sm font-medium text-gray-800">Docs</p>
                <h2 className="mt-3 text-3xl font-semibold leading-tight sm:text-5xl">
                  Run a small scan first.
                </h2>
                <p className="mt-5 max-w-xl text-base leading-7 text-gray-900">
                  deepsec uses strong models at high thinking budgets, so a full scan of a large
                  repository costs real money. Start with a limited pass, read the findings, and
                  scale up once you trust the output.
                </p>
              </div>
              <Button asChild className="shadow-none" size="lg" variant="outline">
                <Link href={docsUrl}>Open docs</Link>
              </Button>
            </div>
            <div className="mt-10 grid gap-px border border-gray-alpha-400 bg-gray-alpha-400 md:grid-cols-2 lg:grid-cols-3">
              {docs.map((doc) => (
                <Link
                  key={doc.href}
                  href={doc.href}
                  className="group bg-background-100 p-6 transition-colors hover:bg-background-200"
                >
                  <p className="font-mono text-xs text-gray-800">{doc.tag}</p>
                  <h3 className="mt-8 text-xl font-semibold group-hover:underline">{doc.title}</h3>
                  <p className="mt-3 text-sm leading-6 text-gray-900">{doc.summary}</p>
                </Link>
              ))}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

function ComparisonRow({ item }: { item: { label: string; review: string; deepsec: string } }) {
  return (
    <>
      <div className="border-r border-t border-gray-alpha-400 p-3 font-mono text-xs text-gray-800">
        {item.label}
      </div>
      <div className="border-r border-t border-gray-alpha-400 p-3 text-gray-900">{item.review}</div>
      <div className="border-t border-gray-alpha-400 p-3 font-medium text-gray-1000">
        {item.deepsec}
      </div>
    </>
  );
}
