import { notFound } from "next/navigation";
import type { Metadata } from "next";
import type { SearchParams } from "@/contracts/screens";
import { loadResourcesScreen } from "@/server/screens";
import { ResourcesScreen } from "@/components/screens/resources-screen";

type Props = {
  params: Promise<{ topic: string }>;
  searchParams: Promise<SearchParams>;
};
export async function generateMetadata({
  params,
  searchParams,
}: Props): Promise<Metadata> {
  const { topic } = await params;
  const query = await searchParams;
  const data = loadResourcesScreen(query, topic);
  if (!data)
    return {
      title: "자료 길잡이를 찾을 수 없습니다",
      robots: { index: false, follow: false },
    };
  return {
    title: data.selected!.title,
    alternates: { canonical: `/resources/${topic}` },
    ...(Object.keys(query).length
      ? { robots: { index: false, follow: true } }
      : {}),
  };
}
export default async function ResourceTopic({ params, searchParams }: Props) {
  const { topic } = await params;
  const data = loadResourcesScreen(await searchParams, topic);
  if (!data) notFound();
  return <ResourcesScreen data={data} />;
}
