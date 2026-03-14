import { MongoClient } from 'mongodb'

import { config } from './config.js'

let clientPromise: Promise<MongoClient> | null = null

export async function getMongoClient() {
  if (!clientPromise) {
    const client = new MongoClient(config.databaseUrl)
    clientPromise = client.connect()
  }

  return clientPromise
}

export async function getGiftsCollection() {
  const client = await getMongoClient()
  return client.db().collection('gifts')
}
