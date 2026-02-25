import artifactDisplayData from "../data/artifact-display.json";

const ICON_CDN_BASE_URL = "https://eggincassets.tcl.sh";
const SMALL_ICON_SIZE = 32;
const LARGE_ICON_SIZE = 256;

type RawArtifactDisplayData = {
  id: string;
  name: string;
  tierNumber: number;
  tierName: string;
  iconFilename: string;
};

export type ArtifactDisplayData = {
  id: string;
  name: string;
  tierNumber: number;
  tierName: string;
  iconFilename: string;
  smallIconUrl: string;
  largeIconUrl: string;
};

const artifactDisplayMap = artifactDisplayData as Record<string, RawArtifactDisplayData>;

export function getArtifactDisplayData(artifact: string): ArtifactDisplayData | null {
  const raw = artifactDisplayMap[artifact];
  if (!raw) {
    return null;
  }
  return {
    ...raw,
    smallIconUrl: `${ICON_CDN_BASE_URL}/${SMALL_ICON_SIZE}/egginc/${raw.iconFilename}`,
    largeIconUrl: `${ICON_CDN_BASE_URL}/${LARGE_ICON_SIZE}/egginc/${raw.iconFilename}`,
  };
}

export function getArtifactDisplayLabel(artifact: string): string {
  const data = getArtifactDisplayData(artifact);
  if (!data) {
    return artifact;
  }
  return `${data.name} (T${data.tierNumber})`;
}
