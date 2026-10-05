import type { Metadata } from "next";
import type { SearchParams } from "@/contracts/screens";
import { loadResourcesScreen } from "@/server/screens";
import { ResourcesScreen } from "@/components/screens/resources-screen";

type Props = { searchParams: Promise<SearchParams> };
export async function generateMetadata({
  searchParams,
}: Props): Promise<Metadata> {
  const params = await searchParams;
  return {
    title: "주제",
    alternates: { canonical: "/resources" },
    ...(Object.keys(params).length
      ? { robots: { index: false, follow: true } }
      : {}),
  };
}
export default async function Resources({ searchParams }: Props) {
  return <ResourcesScreen data={loadResourcesScreen(await searchParams)!} />;
}
