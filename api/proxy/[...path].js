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
    // Expected incoming URL: '/api/proxy/ideagrouperdc.com/api/....?query'
    let incoming = req.url || ''
    // remove leading /
    if (incoming.startsWith('/')) incoming = incoming.slice(1)
    // strip the proxy prefix if present
    if (incoming.startsWith('api/proxy/')) incoming = incoming.slice('api/proxy/'.length)
    // split off querystring
    const [pathOnly, qs] = incoming.split('?')
    const firstSlash = pathOnly.indexOf('/')
    let host, rest
    if (firstSlash === -1) {
      host = pathOnly
      rest = ''
    } else {
      host = pathOnly.slice(0, firstSlash)
      rest = pathOnly.slice(firstSlash) // includes leading '/'
    }
    const query = qs ? `?${qs}` : ''
    const debug = !!(qs && qs.includes('_debug=1'))
    if (!host) {
      res.statusCode = 400
      res.end('Missing host in proxy path')
      return
    }

    const target = `https://${host}${rest}${query}`
    console.log('[proxy] target=', target, 'method=', req.method)

    // Handle OPTIONS locally to avoid unnecessary upstream errors
    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type')
      res.end()
      return
    }

    const rawBody = await getRawBody(req)

    const headers = { ...req.headers }
    // Ensure upstream receives expected Host header
    headers.host = host
    // Log incoming header names for debugging (avoid logging values)
    try {
      console.log('[proxy] incoming headers:', Object.keys(headers))
    } catch (e) {}

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
      // If debug flag present, return JSON with upstream details
      if (debug) {
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        const headersObj = {}
        upstreamResp.headers.forEach((v, k) => headersObj[k] = v)
        res.statusCode = 200
        res.end(JSON.stringify({ target, upstreamStatus: upstreamResp.status, upstreamHeaders: headersObj, upstreamBody: buf.toString('utf8') }))
        return
      }
      // Copy status and headers
      res.statusCode = upstreamResp.status
      upstreamResp.headers.forEach((v, k) => {
        // Avoid sending hop-by-hop headers
        if (['transfer-encoding', 'connection'].includes(k.toLowerCase())) return
        res.setHeader(k, v)
      })
      if (upstreamResp.status >= 400) {
        console.error('[proxy] upstream error', upstreamResp.status, target, buf.toString('utf8'))
      }
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
      const chunks = []
      up.on('data', (c) => chunks.push(Buffer.from(c)))
      up.on('end', () => {
        const bodyBuf = Buffer.concat(chunks)
        // If debug flag present, return JSON with upstream details
        if (debug) {
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          const headersObj = {}
          Object.entries(up.headers || {}).forEach(([k, v]) => { headersObj[k] = v })
          res.statusCode = 200
          res.end(JSON.stringify({ target, upstreamStatus: up.statusCode || 200, upstreamHeaders: headersObj, upstreamBody: bodyBuf.toString('utf8') }))
          return
        }
        res.statusCode = up.statusCode || 200
        Object.entries(up.headers || {}).forEach(([k, v]) => {
          if (['transfer-encoding', 'connection'].includes(k.toLowerCase())) return
          res.setHeader(k, v)
        })
        if ((up.statusCode || 0) >= 400) {
          console.error('[proxy] upstream error', up.statusCode, target, bodyBuf.toString('utf8'))
        }
        res.end(bodyBuf)
      })
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
