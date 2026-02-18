self.onmessage = async (e: any) => {
  const { files, url, concurrency } = e.data
  let active = 0
  let index = 0
  let completed = 0
  const errors: any[] = []

  const processNext = async () => {
    if (index >= files.length) return
    const currentIndex = index++
    const item = files[currentIndex]
    active++

    try {
      const formData = new FormData()
      formData.append('file', item.file)
      formData.append('name', item.name)
      formData.append('category', item.category)
      formData.append('tags', item.tags)
      formData.append('aiAnalysis', item.aiAnalysis)

      const response = await fetch(url, {
        method: 'POST',
        body: formData
      })

      if (!response.ok) {
        const text = await response.text()
        throw new Error(`Upload failed: ${response.status} ${text}`)
      }

      self.postMessage({ type: 'progress', current: ++completed, total: files.length })
    } catch (err: any) {
      errors.push({ file: item.name, error: err?.message || String(err) })
      console.error(`Upload error for ${item.name}:`, err)
    } finally {
      active--
      if (index < files.length) {
        processNext()
      } else if (active === 0) {
        self.postMessage({ type: 'done', errors })
      }
    }
  }

  for (let i = 0; i < Math.min(concurrency, files.length); i++) {
    processNext()
  }
}
