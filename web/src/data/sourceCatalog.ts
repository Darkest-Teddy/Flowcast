import type { DataSource } from './types';

/** Describe the files actually recorded in the deployed bundle; never infer feed health. */
export function sourcesFromCampusBundle(value: unknown): DataSource[] {
  if (!value || typeof value !== 'object' || !('inputFiles' in value) || !Array.isArray(value.inputFiles)) {
    throw new Error('The campus bundle has no source provenance inventory.');
  }
  return value.inputFiles.map((file: unknown) => {
    if (!file || typeof file !== 'object' || !('path' in file) || typeof file.path !== 'string'
      || !('sha256' in file) || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(file.sha256)) {
      throw new Error('The campus source inventory contains an invalid record.');
    }
    return {
      id: file.path,
      name: file.path.split('/').at(-1)!.replace(/\.json$/, '').replaceAll('_', ' '),
      via: file.path,
      feeds: 'Deployed campus bundle',
      group: 'prebuilt' as const,
      health: 'attention' as const,
      statusText: 'Saved snapshot · live status unverified',
      updatedAt: null,
      size: null,
      action: 'Details',
      settings: [{ key: 'sha256', label: 'Recorded SHA-256', value: file.sha256 }],
    };
  });
}
