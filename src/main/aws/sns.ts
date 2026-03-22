import {
  CreateTopicCommand,
  DeleteTopicCommand,
  GetTopicAttributesCommand,
  ListSubscriptionsByTopicCommand,
  ListTagsForResourceCommand,
  ListTopicsCommand,
  PublishCommand,
  SNSClient,
  SetTopicAttributesCommand,
  SubscribeCommand,
  TagResourceCommand,
  UnsubscribeCommand,
  UntagResourceCommand
} from '@aws-sdk/client-sns'

import { awsClientConfig } from './client'
import type {
  AwsConnection,
  SnsPublishResult,
  SnsSubscriptionSummary,
  SnsTopicSummary
} from '@shared/types'

function createClient(connection: AwsConnection): SNSClient {
  return new SNSClient(awsClientConfig(connection))
}

export async function listTopics(connection: AwsConnection): Promise<SnsTopicSummary[]> {
  const client = createClient(connection)
  const topics: SnsTopicSummary[] = []
  let nextToken: string | undefined

  do {
    const output = await client.send(new ListTopicsCommand({ NextToken: nextToken }))
    for (const topic of output.Topics ?? []) {
      if (!topic.TopicArn) continue

      const attrs = await client.send(new GetTopicAttributesCommand({ TopicArn: topic.TopicArn }))
      const a = attrs.Attributes ?? {}

      let tags: Record<string, string> = {}
      try {
        const tagResp = await client.send(new ListTagsForResourceCommand({ ResourceArn: topic.TopicArn }))
        for (const t of tagResp.Tags ?? []) {
          if (t.Key) tags[t.Key] = t.Value ?? ''
        }
      } catch { /* tags may not be accessible */ }

      topics.push({
        topicArn: topic.TopicArn,
        name: topic.TopicArn.split(':').pop() ?? '-',
        displayName: a.DisplayName ?? '',
        subscriptionCount: Number(a.SubscriptionsConfirmed ?? 0) + Number(a.SubscriptionsPending ?? 0),
        policy: a.Policy ?? '',
        deliveryPolicy: a.DeliveryPolicy ?? '',
        effectiveDeliveryPolicy: a.EffectiveDeliveryPolicy ?? '',
        owner: a.Owner ?? '-',
        kmsMasterKeyId: a.KmsMasterKeyId ?? '',
        fifoTopic: a.FifoTopic === 'true',
        contentBasedDeduplication: a.ContentBasedDeduplication === 'true',
        tags
      })
    }
    nextToken = output.NextToken
  } while (nextToken)

  return topics
}

export async function getTopicDetail(connection: AwsConnection, topicArn: string): Promise<SnsTopicSummary> {
  const client = createClient(connection)
  const attrs = await client.send(new GetTopicAttributesCommand({ TopicArn: topicArn }))
  const a = attrs.Attributes ?? {}

  let tags: Record<string, string> = {}
  try {
    const tagResp = await client.send(new ListTagsForResourceCommand({ ResourceArn: topicArn }))
    for (const t of tagResp.Tags ?? []) {
      if (t.Key) tags[t.Key] = t.Value ?? ''
    }
  } catch { /* ignore */ }

  return {
    topicArn,
    name: topicArn.split(':').pop() ?? '-',
    displayName: a.DisplayName ?? '',
    subscriptionCount: Number(a.SubscriptionsConfirmed ?? 0) + Number(a.SubscriptionsPending ?? 0),
    policy: a.Policy ?? '',
    deliveryPolicy: a.DeliveryPolicy ?? '',
    effectiveDeliveryPolicy: a.EffectiveDeliveryPolicy ?? '',
    owner: a.Owner ?? '-',
    kmsMasterKeyId: a.KmsMasterKeyId ?? '',
    fifoTopic: a.FifoTopic === 'true',
    contentBasedDeduplication: a.ContentBasedDeduplication === 'true',
    tags
  }
}

export async function createTopic(
  connection: AwsConnection,
  name: string,
  fifo: boolean,
  attributes?: Record<string, string>
): Promise<string> {
  const client = createClient(connection)
  const topicName = fifo && !name.endsWith('.fifo') ? `${name}.fifo` : name
  const attrs: Record<string, string> = { ...(attributes ?? {}) }
  if (fifo) attrs.FifoTopic = 'true'

  const output = await client.send(new CreateTopicCommand({ Name: topicName, Attributes: attrs }))
  return output.TopicArn ?? ''
}

export async function deleteTopic(connection: AwsConnection, topicArn: string): Promise<void> {
  const client = createClient(connection)
  await client.send(new DeleteTopicCommand({ TopicArn: topicArn }))
}

export async function setTopicAttribute(
  connection: AwsConnection,
  topicArn: string,
  attributeName: string,
  attributeValue: string
): Promise<void> {
  const client = createClient(connection)
  await client.send(new SetTopicAttributesCommand({
    TopicArn: topicArn,
    AttributeName: attributeName,
    AttributeValue: attributeValue
  }))
}

export async function listSubscriptions(connection: AwsConnection, topicArn: string): Promise<SnsSubscriptionSummary[]> {
  const client = createClient(connection)
  const subs: SnsSubscriptionSummary[] = []
  let nextToken: string | undefined

  do {
    const output = await client.send(new ListSubscriptionsByTopicCommand({ TopicArn: topicArn, NextToken: nextToken }))
    for (const sub of output.Subscriptions ?? []) {
      subs.push({
        subscriptionArn: sub.SubscriptionArn ?? '-',
        topicArn: sub.TopicArn ?? topicArn,
        protocol: sub.Protocol ?? '-',
        endpoint: sub.Endpoint ?? '-',
        owner: sub.Owner ?? '-',
        confirmationWasAuthenticated: false,
        pendingConfirmation: sub.SubscriptionArn === 'PendingConfirmation',
        rawMessageDelivery: false,
        filterPolicy: ''
      })
    }
    nextToken = output.NextToken
  } while (nextToken)

  return subs
}

export async function subscribe(
  connection: AwsConnection,
  topicArn: string,
  protocol: string,
  endpoint: string
): Promise<string> {
  const client = createClient(connection)
  const output = await client.send(new SubscribeCommand({
    TopicArn: topicArn,
    Protocol: protocol,
    Endpoint: endpoint,
    ReturnSubscriptionArn: true
  }))
  return output.SubscriptionArn ?? ''
}

export async function unsubscribe(connection: AwsConnection, subscriptionArn: string): Promise<void> {
  const client = createClient(connection)
  await client.send(new UnsubscribeCommand({ SubscriptionArn: subscriptionArn }))
}

export async function publishMessage(
  connection: AwsConnection,
  topicArn: string,
  message: string,
  subject?: string,
  messageGroupId?: string,
  messageDeduplicationId?: string
): Promise<SnsPublishResult> {
  const client = createClient(connection)
  const output = await client.send(new PublishCommand({
    TopicArn: topicArn,
    Message: message,
    Subject: subject || undefined,
    MessageGroupId: messageGroupId || undefined,
    MessageDeduplicationId: messageDeduplicationId || undefined
  }))
  return {
    messageId: output.MessageId ?? '',
    sequenceNumber: output.SequenceNumber ?? ''
  }
}

export async function tagTopic(connection: AwsConnection, topicArn: string, tags: Record<string, string>): Promise<void> {
  const client = createClient(connection)
  await client.send(new TagResourceCommand({
    ResourceArn: topicArn,
    Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value }))
  }))
}

export async function untagTopic(connection: AwsConnection, topicArn: string, tagKeys: string[]): Promise<void> {
  const client = createClient(connection)
  await client.send(new UntagResourceCommand({
    ResourceArn: topicArn,
    TagKeys: tagKeys
  }))
}
