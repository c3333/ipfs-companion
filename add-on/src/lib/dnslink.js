'use strict'
/* eslint-env browser */

const IsIpfs = require('is-ipfs')
const LRU = require('lru-cache')

module.exports = function createDnslinkResolver (getState) {
  // DNSLink lookup result cache
  const cacheOptions = {max: 1000, maxAge: 1000 * 60 * 60}
  const cache = new LRU(cacheOptions)

  const dnslinkResolver = {
    isDnslookupPossible () {
      // DNS lookups require IPFS API to be up
      return getState().peerCount >= 0
    },

    isDnslookupSafeForURL (requestUrl) {
      // skip URLs that could produce infinite recursion or weird loops
      const state = getState()
      return state.dnslinkPolicy &&
        dnslinkResolver.isDnslookupPossible() &&
        requestUrl.startsWith('http') &&
        !IsIpfs.url(requestUrl) &&
        !requestUrl.startsWith(state.apiURLString) &&
        !requestUrl.startsWith(state.gwURLString)
    },

    dnslinkRedirect (requestUrl, dnslink) {
      const url = new URL(requestUrl)
      if (dnslinkResolver.canRedirectToIpns(url, dnslink)) {
        // redirect to IPNS and leave it up to the gateway
        // to load the correct path from IPFS
        // - https://github.com/ipfs/ipfs-companion/issues/298
        return dnslinkResolver.redirectToIpnsPath(url)
      }
    },

    setDnslink (fqdn, value) {
      cache.set(fqdn, value)
    },

    clearCache () {
      cache.reset()
    },

    cachedDnslink (fqdn) {
      return cache.get(fqdn)
    },

    readAndCacheDnslink (fqdn) {
      let dnslink = dnslinkResolver.cachedDnslink(fqdn)
      if (typeof dnslink === 'undefined') {
        try {
          console.info(`[ipfs-companion] dnslink cache miss for '${fqdn}', running DNS TXT lookup`)
          dnslink = dnslinkResolver.readDnslinkFromTxtRecord(fqdn)
          if (dnslink) {
            dnslinkResolver.setDnslink(fqdn, dnslink)
            console.info(`[ipfs-companion] found dnslink: '${fqdn}' -> '${dnslink}'`)
          } else {
            dnslinkResolver.setDnslink(fqdn, false)
            console.info(`[ipfs-companion] found NO dnslink for '${fqdn}'`)
          }
        } catch (error) {
          console.error(`[ipfs-companion] Error in readAndCacheDnslink for '${fqdn}'`)
          console.error(error)
        }
      } else {
        // Most of the time we will hit cache, which makes below line is too noisy
        // console.info(`[ipfs-companion] using cached dnslink: '${fqdn}' -> '${dnslink}'`)
      }
      return dnslink
    },

    readDnslinkFromTxtRecord (fqdn) {
      // js-ipfs-api does not provide method for fetching this
      // TODO: revisit after https://github.com/ipfs/js-ipfs-api/issues/501 is addressed
      // TODO: consider worst-case-scenario fallback to https://developers.google.com/speed/public-dns/docs/dns-over-https
      const apiCall = `${getState().apiURLString}api/v0/dns/${fqdn}`
      const xhr = new XMLHttpRequest() // older XHR API us used because window.fetch appends Origin which causes error 403 in go-ipfs
      // synchronous mode with small timeout
      // (it is okay, because we do it only once, then it is cached and read via readAndCacheDnslink)
      xhr.open('GET', apiCall, false)
      xhr.setRequestHeader('Accept', 'application/json')
      xhr.send(null)
      if (xhr.status === 200) {
        const dnslink = JSON.parse(xhr.responseText).Path
        // console.log('readDnslinkFromTxtRecord', readDnslinkFromTxtRecord)
        if (!IsIpfs.path(dnslink)) {
          throw new Error(`dnslink for '${fqdn}' is not a valid IPFS path: '${dnslink}'`)
        }
        return dnslink
      } else if (xhr.status === 500) {
        // go-ipfs returns 500 if host has no dnslink
        // TODO: find/fill an upstream bug to make this more intuitive
        return false
      } else {
        throw new Error(xhr.statusText)
      }
    },

    canRedirectToIpns (url, dnslink) {
      // Safety check: detect and skip gateway paths
      // Public gateways such as ipfs.io are often exposed under the same domain name.
      // We don't want dnslink to interfere with content-addressing redirects,
      // or things like /api/v0 paths exposed by the writable gateway
      // so we ignore known namespaces exposed by HTTP2IPFS gateways
      // and ignore them even if things like CID are invalid
      // -- we don't want to skew errors from gateway
      const path = url.pathname
      const httpGatewayPath = path.startsWith('/ipfs/') || path.startsWith('/ipns/') || path.startsWith('/api/v')
      if (!httpGatewayPath) {
        const fqdn = url.hostname
        // If dnslink policy is 'eagerDnsTxtLookup' then lookups will be executed for every unique hostname on every visited website
        // Until we get efficient  DNS TXT Lookup API it will come with overhead, so it is opt-in for now,
        // and we do lookup to populate dnslink cache only when X-Ipfs-Path header is found in initial response.
        const foundDnslink = dnslink ||
          (getState().dnslinkPolicy === 'eagerDnsTxtLookup'
            ? dnslinkResolver.readAndCacheDnslink(fqdn)
            : dnslinkResolver.cachedDnslink(fqdn))
        if (foundDnslink) {
          return true
        }
      }
      return false
    },

    redirectToIpnsPath (originalUrl) {
      // TODO: redirect to `ipns://` if hasNativeProtocolHandler === true
      const fqdn = originalUrl.hostname
      const state = getState()
      const gwUrl = state.ipfsNodeType === 'embedded' ? state.pubGwURL : state.gwURL
      const url = new URL(originalUrl)
      url.protocol = gwUrl.protocol
      url.host = gwUrl.host
      url.port = gwUrl.port
      url.pathname = `/ipns/${fqdn}${url.pathname}`
      return { redirectUrl: url.toString() }
    }
  }

  return dnslinkResolver
}
