import fs from 'fs'
import path from 'path'
import { Readable, Writable } from 'stream'

import last from 'it-last'
import pipe from 'it-pipe'

import { CarWriter } from '@ipld/car'
import {importer, ImportResult} from 'ipfs-unixfs-importer'
import { normaliseInput } from 'ipfs-core-utils/files/normalise-input-multiple'
import globSource from 'ipfs-utils/src/files/glob-source.js'

import { MemoryBlockStore } from '../blockstore/memory'
import { unixfsImporterOptionsDefault } from './constants'

import type { PackProperties } from './index'

export interface PackToStreamProperties extends PackProperties {
  input: string | Iterable<string> | AsyncIterable<string>,
  writable: Writable
}

// Node version of toCar with Node Stream Writable
export async function packToStream ({ input, writable, blockstore: userBlockstore, hasher, maxChunkSize, maxChildrenPerNode, wrapWithDirectory, rawLeaves, customHandler }: PackToStreamProperties) {
  if (!input || (Array.isArray(input) && !input.length)) {
    throw new Error('given input could not be parsed correctly')
  }
  input = typeof input === 'string' ? [input] : input

  const blockstore = userBlockstore ? userBlockstore : new MemoryBlockStore()

  // Consume the source
  const rootEntry = await last(pipe(
    legacyGlobSource(input),
    source => normaliseInput(source),
    (source: any) => importer(source, blockstore, {
      ...unixfsImporterOptionsDefault,
      hasher: hasher || unixfsImporterOptionsDefault.hasher,
      maxChunkSize: maxChunkSize || unixfsImporterOptionsDefault.maxChunkSize,
      maxChildrenPerNode: maxChildrenPerNode || unixfsImporterOptionsDefault.maxChildrenPerNode,
      wrapWithDirectory: wrapWithDirectory === false ? false : unixfsImporterOptionsDefault.wrapWithDirectory,
      rawLeaves: rawLeaves == null ? unixfsImporterOptionsDefault.rawLeaves : rawLeaves
    }),
    customHandler ? customHandler : (sources: AsyncGenerator<ImportResult, void, unknown>) => sources
  ))

  if (!rootEntry || !rootEntry.cid) {
    throw new Error('given input could not be parsed correctly')
  }

  const root = rootEntry.cid

  const { writer, out } = await CarWriter.create([root])
  Readable.from(out).pipe(writable)

  for await (const block of blockstore.blocks()) {
    await writer.put(block)
  }

  await writer.close()

  if (!userBlockstore) {
    await blockstore.close()
  }

  return { root }
}

/**
 * This function replicates the old behaviour of globSource to not introduce a
 * breaking change.
 *
 * TODO: figure out what the breaking change will be.
 */
async function * legacyGlobSource (input: Iterable<string> | AsyncIterable<string>) {
  for await (const p of input) {
    const resolvedPath = path.resolve(p)
    const stat = await fs.promises.stat(resolvedPath)
    const fileName = path.basename(resolvedPath)
    if (stat.isDirectory()) {
      yield { path: fileName }
      for await (const candidate of globSource(resolvedPath, '**/*')) {
        yield { ...candidate, path: path.join(fileName, candidate.path) }
      }
    } else {
      yield { path: fileName, content: fs.createReadStream(resolvedPath) }
    }
  }
}
