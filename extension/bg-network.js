(function initGhostBridgeNetworkHelpers(global) {
  const MAX_NETWORK_URL_OUTPUT_LENGTH = 240
  const NETWORK_URL_HEAD_LENGTH = 180
  const NETWORK_URL_TAIL_LENGTH = 40
  const MAX_DATA_URL_OUTPUT_LENGTH = 256

  function getApiSignalScore(entry) {
    const url = (entry.url || '').toLowerCase()
    let score = 0
    if (url.includes('/api/')) score += 80
    if (url.includes('graphql')) score += 80
    if (url.includes('/rpc/')) score += 60
    if (url.includes('/rest/')) score += 40
    if ((entry.method || 'GET').toUpperCase() !== 'GET') score += 25
    return score
  }

  function getResourceTypeScore(entry, mode = 'debug') {
    const type = (entry.resourceType || '').toLowerCase()
    const debugScores = {
      fetch: 140,
      xhr: 140,
      websocket: 120,
      document: 90,
      script: 45,
      stylesheet: 25,
      other: 0,
      image: -40,
      font: -40,
      media: -50,
    }
    const apiScores = {
      fetch: 220,
      xhr: 220,
      websocket: 160,
      document: 40,
      script: -10,
      stylesheet: -20,
      other: 0,
      image: -80,
      font: -80,
      media: -90,
    }
    const table = mode === 'api' ? apiScores : debugScores
    return table[type] ?? table.other
  }

  function getStatusScore(entry) {
    if (entry.status === 'failed') return 360
    if (entry.status === 'error') return 330
    if (entry.status === 'pending') return 280
    if ((entry.statusCode || 0) >= 500) return 340
    if ((entry.statusCode || 0) >= 400) return 300
    return 80
  }

  function getNetworkPriorityScore(entry, mode = 'debug') {
    if (mode === 'recent') {
      return entry.timestamp || 0
    }

    let score = getStatusScore(entry)
    score += getResourceTypeScore(entry, mode)
    score += getApiSignalScore(entry)

    if (entry.fromCache) score -= 20
    if ((entry.encodedDataLength || 0) === 0 && entry.status === 'success') score -= 10

    return score
  }

  function compareNetworkEntries(a, b, mode = 'debug') {
    if (mode === 'recent') {
      return (b.timestamp || 0) - (a.timestamp || 0)
    }

    const scoreDiff = getNetworkPriorityScore(b, mode) - getNetworkPriorityScore(a, mode)
    if (scoreDiff !== 0) return scoreDiff
    return (b.timestamp || 0) - (a.timestamp || 0)
  }

  function summarizeNetworkUrl(url) {
    if (!url) return { displayUrl: url }

    const urlOriginalLength = url.length
    const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(url)
    const urlScheme = schemeMatch?.[1]?.toLowerCase()

    if (urlScheme === 'data') {
      const commaIndex = url.indexOf(',')
      const meta = commaIndex >= 0 ? url.slice(5, commaIndex) : url.slice(5)
      const dataUrlMimeType = (meta.split(';')[0] || 'text/plain').toLowerCase()
      const isBase64 = meta.includes(';base64')

      if (!isBase64 && urlOriginalLength <= MAX_DATA_URL_OUTPUT_LENGTH) {
        return {
          displayUrl: url,
          urlOriginalLength,
          urlScheme,
          urlTruncated: false,
          dataUrlMimeType,
        }
      }

      return {
        displayUrl: `data:${dataUrlMimeType}${isBase64 ? ';base64' : ''},<omitted ${urlOriginalLength} chars>`,
        urlOriginalLength,
        urlScheme,
        urlTruncated: true,
        dataUrlMimeType,
      }
    }

    if (urlOriginalLength > MAX_NETWORK_URL_OUTPUT_LENGTH) {
      return {
        displayUrl: `${url.slice(0, NETWORK_URL_HEAD_LENGTH)}...${url.slice(-NETWORK_URL_TAIL_LENGTH)}`,
        urlOriginalLength,
        urlScheme,
        urlTruncated: true,
      }
    }

    return {
      displayUrl: url,
      urlOriginalLength,
      urlScheme,
      urlTruncated: false,
    }
  }

  function buildNetworkRequestSummary(entry) {
    const urlMeta = summarizeNetworkUrl(entry.url)
    return {
      requestId: entry.requestId,
      url: urlMeta.displayUrl,
      ...(urlMeta.urlTruncated ? { urlTruncated: true, urlOriginalLength: urlMeta.urlOriginalLength } : {}),
      ...(urlMeta.urlScheme ? { urlScheme: urlMeta.urlScheme } : {}),
      ...(urlMeta.dataUrlMimeType ? { dataUrlMimeType: urlMeta.dataUrlMimeType } : {}),
      method: entry.method,
      status: entry.status,
      statusCode: entry.statusCode,
      resourceType: entry.resourceType,
      mimeType: entry.mimeType,
      duration: entry.duration,
      encodedDataLength: entry.encodedDataLength,
      fromCache: entry.fromCache,
      timestamp: entry.timestamp,
      errorText: entry.errorText,
    }
  }

  function trimTrackedRequests(list, maxRequestsTracked) {
    while (list.length > maxRequestsTracked) {
      let worstIndex = 0
      for (let i = 1; i < list.length; i++) {
        const candidate = list[i]
        const worst = list[worstIndex]
        const cmp = compareNetworkEntries(candidate, worst, 'debug')
        if (cmp < 0 || (cmp === 0 && (candidate.timestamp || 0) < (worst.timestamp || 0))) {
          worstIndex = i
        }
      }
      list.splice(worstIndex, 1)
    }
  }

  function trimPendingRequestMap(requestMap, maxPendingRequests) {
    while (requestMap.size > maxPendingRequests) {
      const entries = [...requestMap.entries()]
      let worstKey = entries[0]?.[0]
      let worstValue = entries[0]?.[1]

      for (let i = 1; i < entries.length; i++) {
        const [key, value] = entries[i]
        const cmp = compareNetworkEntries(value, worstValue, 'debug')
        if (cmp < 0 || (cmp === 0 && (value.timestamp || 0) < (worstValue.timestamp || 0))) {
          worstKey = key
          worstValue = value
        }
      }

      if (!worstKey) break
      requestMap.delete(worstKey)
    }
  }

  global.GhostBridgeNetwork = {
    compareNetworkEntries,
    summarizeNetworkUrl,
    buildNetworkRequestSummary,
    trimTrackedRequests,
    trimPendingRequestMap,
  }
})(self)
