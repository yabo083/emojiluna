self.onmessage = async (e: any) => {
  const { files, sampleSize = 10240, concurrency = 4 } = e.data
  const results: any[] = []
  let idx = 0

  const readSample = async (file: File) => {
    const size = file.size
    const needFull = size <= sampleSize * 3
    const parts: BlobPart[] = []

    if (needFull) {
      parts.push(file)
    } else {
      parts.push(file.slice(0, sampleSize))
      const midStart = Math.floor(size / 2) - Math.floor(sampleSize / 2)
      parts.push(file.slice(midStart, midStart + sampleSize))
      parts.push(file.slice(size - sampleSize))
    }
    
    const blob = new Blob(parts)
    const buffer = await blob.arrayBuffer()
    const digest = await crypto.subtle.digest('SHA-256', buffer)
    const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
    return hex
  }

  const workerLoop = async () => {
    while (true) {
      const i = idx++
      if (i >= files.length) break
      const item = files[i]
      try {
        const hash = await readSample(item.file)
        self.postMessage({ type: 'hash', index: i, name: item.name, hash })
      } catch (err: any) {
        self.postMessage({ type: 'error', index: i, name: item.name, error: err?.message || String(err) })
      }
    }
  }

  const workers = []
  for (let w = 0; w < Math.min(concurrency, files.length); w++) {
    workers.push(workerLoop())
  }
  await Promise.all(workers)
  self.postMessage({ type: 'done' })
}
