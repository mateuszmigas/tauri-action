import { readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';

import { getOctokit } from '@actions/github';

import { uploadAssets } from './upload-release-assets';
import { getAssetName } from './utils';

import type { Artifact, TargetInfo } from './types';

type Platform = {
  signature: string;
  url: string;
};

type VersionContent = {
  version: string;
  notes: string;
  pub_date: string;
  platforms: {
    [key: string]: Platform;
  };
};

export async function uploadVersionJSON({
  owner,
  repo,
  version,
  notes,
  tagName,
  releaseId,
  artifacts,
  targetInfo,
  updaterJsonPreferNsis,
  updaterJsonKeepUniversal,
}: {
  owner: string;
  repo: string;
  version: string;
  notes: string;
  tagName: string;
  releaseId: number;
  artifacts: Artifact[];
  targetInfo: TargetInfo;
  updaterJsonPreferNsis: boolean;
  updaterJsonKeepUniversal: boolean;
}) {
  if (process.env.GITHUB_TOKEN === undefined) {
    throw new Error('GITHUB_TOKEN is required');
  }

  const github = getOctokit(process.env.GITHUB_TOKEN);

  const versionFilename = 'latest.json';
  const versionFile = resolve(process.cwd(), versionFilename);
  const versionContent: VersionContent = {
    version,
    notes,
    pub_date: new Date().toISOString(),
    platforms: {},
  };

  const assets = await github.rest.repos.listReleaseAssets({
    owner: owner,
    repo: repo,
    release_id: releaseId,
    per_page: 50,
  });
  const asset = assets.data.find((e) => e.name === versionFilename);

  if (asset) {
    const assetData = (
      await github.request(
        'GET /repos/{owner}/{repo}/releases/assets/{asset_id}',
        {
          owner: owner,
          repo: repo,
          asset_id: asset.id,
          headers: {
            accept: 'application/octet-stream',
          },
        },
      )
    ).data as unknown as ArrayBuffer;

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    versionContent.platforms = JSON.parse(
      Buffer.from(assetData).toString(),
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    ).platforms;
  }

  const downloadUrls = new Map<string, string>();
  for (const data of assets.data) {
    downloadUrls.set(data.name, data.browser_download_url);
  }

  // Assets matching artifacts generated by this action
  const filteredAssets = [];
  for (const artifact of artifacts) {
    const asset = getAssetName(artifact.path);
    const assetName = asset
      .trim()
      .replace(/[ ()[\]{}]/g, '.')
      .replace(/\.\./g, '.')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
    const downloadUrl = downloadUrls.get(assetName);
    console.warn({
      asset,
      assetName,
      downloadUrl,
    });
    if (downloadUrl) {
      filteredAssets.push({
        downloadUrl,
        assetName,
        path: artifact.path,
        arch: artifact.arch,
      });
    }
  }

  const signatureFiles = filteredAssets.filter((asset) => {
    return asset.assetName.endsWith('.sig');
  });

  console.warn('[MM] Uploading version JSON with the following assets:');
  console.log({
    signatureFiles,
    artifacts,
  });
  function signaturePriority(signaturePath: string) {
    const priorities = updaterJsonPreferNsis
      ? ['.nsis.zip.sig', '.exe.sig', '.msi.zip.sig', '.msi.sig']
      : ['.msi.zip.sig', '.msi.sig', '.nsis.zip.sig', '.exe.sig'];
    for (const [index, extension] of priorities.entries()) {
      if (signaturePath.endsWith(extension)) {
        return 100 - index;
      }
    }
    return 0;
  }
  signatureFiles.sort((a, b) => {
    return signaturePriority(b.path) - signaturePriority(a.path);
  });
  const signatureFile = signatureFiles[0];
  if (!signatureFile) {
    console.warn(
      '[TEST] Signature not found for the updater JSON. Skipping upload...',
    );
    return;
  }

  const updaterName = basename(
    signatureFile.assetName,
    extname(signatureFile.assetName),
  );
  let downloadUrl = filteredAssets.find(
    (asset) => asset.assetName == updaterName,
  )?.downloadUrl;
  if (!downloadUrl) {
    console.warn('Asset not found for the updater JSON. Skipping upload...');
    return;
  }
  // Untagged release downloads won't work after the release was published
  downloadUrl = downloadUrl.replace(
    /\/download\/(untagged-[^/]+)\//,
    tagName ? `/download/${tagName}/` : '/latest/download/',
  );

  let os = targetInfo.platform as string;
  if (os === 'macos') {
    os = 'darwin';
  }

  let arch = signatureFile.arch;
  arch =
    arch === 'amd64' || arch === 'x86_64' || arch === 'x64'
      ? 'x86_64'
      : arch === 'x86' || arch === 'i386'
        ? 'i686'
        : arch === 'arm'
          ? 'armv7'
          : arch === 'arm64'
            ? 'aarch64'
            : arch;

  // Expected targets: https://github.com/tauri-apps/tauri/blob/fd125f76d768099dc3d4b2d4114349ffc31ffac9/core/tauri/src/updater/core.rs#L856
  if (os === 'darwin' && arch === 'universal') {
    // Don't overwrite native builds
    if (!versionContent.platforms['darwin-aarch64']) {
      (versionContent.platforms['darwin-aarch64'] as unknown) = {
        signature: readFileSync(signatureFile.path).toString(),
        url: downloadUrl,
      };
    }
    if (!versionContent.platforms['darwin-x86_64']) {
      (versionContent.platforms['darwin-x86_64'] as unknown) = {
        signature: readFileSync(signatureFile.path).toString(),
        url: downloadUrl,
      };
    }
  }
  if (updaterJsonKeepUniversal || os !== 'darwin' || arch !== 'universal') {
    (versionContent.platforms[`${os}-${arch}`] as unknown) = {
      signature: readFileSync(signatureFile.path).toString(),
      url: downloadUrl,
    };
  }

  writeFileSync(versionFile, JSON.stringify(versionContent, null, 2));

  if (asset) {
    // https://docs.github.com/en/rest/releases/assets#update-a-release-asset
    await github.rest.repos.deleteReleaseAsset({
      owner: owner,
      repo: repo,
      release_id: releaseId,
      asset_id: asset.id,
    });
  }

  await uploadAssets(owner, repo, releaseId, [{ path: versionFile, arch: '' }]);
}
