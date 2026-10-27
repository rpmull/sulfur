// Normalized mesh state. Phosphorus's existing state messages remain valid;
// other providers can publish peers without claiming to be Phosphorus hosts.
export function meshPeers(state) {
  if (Array.isArray(state.peers)) return [...new Set(state.peers
    .filter((p) => p && typeof p.name === 'string' && p.name && p.online !== false)
    .map((p) => p.name))].sort();
  return [...new Set((state.tailnet || []).filter((p) => p.phosphorus).map((p) => p.name))].sort();
}

// Missing metadata means the legacy Phosphorus API. An explicit capability list
// is authoritative, including an empty list. The embedded desktop is Phosphorus.
export function supportsMesh(standalone, capability) {
  if (!standalone) return true;
  const mesh = standalone.mesh || standalone.info?.mesh;
  if (Array.isArray(mesh?.caps)) return mesh.caps.includes(capability);
  if (mesh?.kind && mesh.kind !== 'phosphorus') return false;
  return standalone.mode === 'mesh' || !!standalone.server;
}
