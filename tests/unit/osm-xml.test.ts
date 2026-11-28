import { describe, expect, it } from 'vitest'
import { decodeEntities, parseOsmXml } from '@/core/data/osm-xml'

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6" generator="CGImap">
  <bounds minlat="-22.9" minlon="-43.2" maxlat="-22.8" maxlon="-43.1"/>
  <node id="1" lat="-22.9" lon="-43.19"/>
  <node id="2" lat="-22.91" lon="-43.18">
    <tag k="railway" v="station"/>
  </node>
  <way id="10" version="2">
    <nd ref="1"/>
    <nd ref="2"/>
    <tag k="highway" v="service"/>
  </way>
  <relation id="7" version="3">
    <member type="way" ref="10" role=""/>
    <member type="node" ref="2" role="stop"/>
    <tag k="route" v="subway"/>
    <tag k="name" v="Metr&#244; &amp; &quot;Co&quot;"/>
  </relation>
</osm>`

describe('parseOsmXml', () => {
  const data = parseOsmXml(SAMPLE)

  it('reads node coordinates', () => {
    expect(data.nodes.get(1)).toEqual({ lat: -22.9, lon: -43.19 })
    expect(data.nodes.get(2)).toEqual({ lat: -22.91, lon: -43.18 })
  })

  it('reads way node references and tags', () => {
    expect(data.ways.get(10)).toEqual({ nodes: [1, 2], tags: { highway: 'service' } })
  })

  it('reads relation members and tags, with entities decoded', () => {
    expect(data.relations.get(7)).toEqual({
      tags: { route: 'subway', name: 'Metrô & "Co"' },
      members: [
        { type: 'way', ref: 10, role: '' },
        { type: 'node', ref: 2, role: 'stop' },
      ],
    })
  })

  it('ignores the header, bounds and nodes without children as containers', () => {
    expect(data.relations.size).toBe(1)
    expect(data.ways.size).toBe(1)
    expect(data.ways.get(10)?.tags).not.toHaveProperty('railway')
  })
})

describe('decodeEntities', () => {
  it('decodes named and numeric entities and leaves unknown ones alone', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &#x41;&#66; &unknown;')).toBe('a & b <c> AB &unknown;')
  })

  it('leaves out-of-range code points as written', () => {
    expect(decodeEntities('&#x110000;')).toBe('&#x110000;')
  })

  it('skips children that belong to no open element', () => {
    const data = parseOsmXml('<tag k="a" v="b"/><nd ref="1"/><member type="way" ref="1" role=""/>')
    expect(data.relations.size + data.ways.size + data.nodes.size).toBe(0)
  })
})
