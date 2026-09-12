async function downloadCurriculumFile(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download curriculum file (HTTP ${res.status})`);
  }
  return Buffer.from(await res.arrayBuffer());
}

module.exports = { downloadCurriculumFile };
