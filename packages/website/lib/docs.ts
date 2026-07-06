import { source } from "@/lib/geistdocs/source";

type FeaturedDoc = {
  title: string;
  summary: string;
  tag: string;
  href: string;
};

const featured: { slug: string; tag: string }[] = [
  { slug: "getting-started", tag: "First scan" },
  { slug: "reviewing-changes", tag: "CI gate" },
  { slug: "supported-tech", tag: "Coverage" },
  { slug: "writing-matchers", tag: "Customize" },
  { slug: "models", tag: "Models" },
  { slug: "vercel-setup", tag: "Scale" },
];

export function getFeaturedDocs(): FeaturedDoc[] {
  return featured.flatMap(({ slug, tag }) => {
    const page = source.getPage([slug], "en");
    if (!page) {
      return [];
    }

    return [
      {
        title: page.data.title ?? slug,
        summary: page.data.description ?? "",
        tag,
        href: page.url,
      },
    ];
  });
}
