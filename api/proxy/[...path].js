const http = require('http')
const https = require('https')

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(Buffer.from(c)))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

// Vercel will call this function for routes under /api/proxy/*
module.exports = async (req, res) => {
  try {
    // req.url will be like '/ideagrouperdc.com/api/..?query=..'
    const full = (req.url || '').replace(/^\//, '')
    const firstSlash = full.indexOf('/')
    let host, rest
    if (firstSlash === -1) {
      host = full
      rest = ''
    } else {
      host = full.slice(0, firstSlash)
      rest = full.slice(firstSlash) // includes leading '/'
    }
    if (!host) {
      res.statusCode = 400
      res.end('Missing host in proxy path')
      return
    }

    const target = `https://${host}${rest}`

    const rawBody = await getRawBody(req)

    const headers = { ...req.headers }
    delete headers.host

    const fetchOptions = {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : rawBody,
      redirect: 'manual'
    }

    // Use global fetch if available, otherwise fallback to node https
    let upstreamResp
    if (typeof fetch !== 'undefined') {
      upstreamResp = await fetch(target, fetchOptions)
      const buf = Buffer.from(await upstreamResp.arrayBuffer())
      // Copy status and headers
      res.statusCode = upstreamResp.status
      upstreamResp.headers.forEach((v, k) => {
        // Avoid sending hop-by-hop headers
        if (['transfer-encoding', 'connection'].includes(k.toLowerCase())) return
        res.setHeader(k, v)
      })
      res.end(buf)
      return
    }

    // Fallback using native https/http
    const isHttps = target.startsWith('https:')
    const lib = isHttps ? https : http
    const u = new URL(target)
    const opts = {
      method: req.method,
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + (u.search || ''),
      headers
    }

    const upstream = lib.request(opts, (up) => {
      res.statusCode = up.statusCode || 200
      Object.entries(up.headers || {}).forEach(([k, v]) => {
        if (['transfer-encoding', 'connection'].includes(k.toLowerCase())) return
        res.setHeader(k, v)
      })
      up.pipe(res)
    })

    upstream.on('error', (err) => {
      res.statusCode = 502
      res.end('Upstream request failed: ' + String(err))
    })

    if (rawBody && rawBody.length) upstream.write(rawBody)
    upstream.end()
  } catch (e) {
    res.statusCode = 500
    res.end(String(e))
  }
}
