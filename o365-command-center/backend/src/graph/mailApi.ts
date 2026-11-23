import type { PublicClientApplication } from '@azure/msal-node';
import { executeBatch } from './batch.js';
import type { BatchRequest, BatchItemResult } from './batch.js';
import { GraphClient, GraphError } from './graphClient.js';
import type {
  GraphBody,
  GraphDeltaResponse,
  GraphFolder,
  GraphListResponse,
  GraphMessage,
  GraphUser,
  WellKnownFolderName,
} from './types.js';

export const MESSAGE_SELECT =
  'id,conversationId,subject,from,sender,toRecipients,ccRecipients,receivedDateTime,sentDateTime,isRead,importance,hasAttachments,flag,categories,bodyPreview,parentFolderId,inferenceClassification,isDraft,webLink';

export class MailApi {
  readonly client: GraphClient;

  constructor(msalClient: PublicClientApplication, homeAccountId: string) {
    this.client = new GraphClient(msalClient, homeAccountId);
  }

  getMe(): Promise<GraphUser> {
    return this.client.get<GraphUser>('/me');
  }

  async listFolders(): Promise<GraphFolder[]> {
    const firstUrl = `/me/mailFolders?$select=id,displayName,parentFolderId,childFolderCount,totalItemCount,unreadItemCount&$top=100`;
    return this.paged<GraphFolder>(firstUrl);
  }

  getWellKnownFolder(name: WellKnownFolderName): Promise<GraphFolder> {
    return this.client.get<GraphFolder>(`/me/mailFolders/${name}`);
  }

  messagesDelta(folderId: string, deltaLinkOrNull: string | null): Promise<GraphDeltaResponse> {
    return this.pagedDelta(folderId, deltaLinkOrNull);
  }

  async *messagesDeltaPages(
    folderId: string,
    deltaLinkOrNull: string | null,
  ): AsyncGenerator<GraphDeltaResponse> {
    const url =
      deltaLinkOrNull ??
      `/me/mailFolders/${encodeURIComponent(folderId)}/messages/delta?$select=${MESSAGE_SELECT}`;
    const visited = new Set<string>();
    let currentUrl: string | undefined = url;
    while (currentUrl) {
      if (visited.has(currentUrl)) {
        throw new GraphError(
          502,
          'paging_cycle',
          undefined,
          'Microsoft Graph returned a repeated page link',
        );
      }
      visited.add(currentUrl);
      const page: GraphDeltaResponse = await this.client.get<GraphDeltaResponse>(
        currentUrl,
        undefined,
        {
          Prefer: 'odata.maxpagesize=50',
        },
      );
      yield page;
      currentUrl = page['@odata.deltaLink'] ? undefined : page['@odata.nextLink'];
    }
  }

  getMessageBody(id: string): Promise<GraphBody> {
    return this.client
      .get<{ body: GraphBody }>(`/me/messages/${encodeURIComponent(id)}?$select=body`)
      .then((message) => message.body);
  }

  batch(requests: BatchRequest[]): Promise<BatchItemResult[]> {
    return executeBatch(this.client, requests);
  }

  private async paged<T>(url: string): Promise<T[]> {
    const values: T[] = [];
    const visited = new Set<string>();
    let currentUrl: string | undefined = url;
    while (currentUrl) {
      if (visited.has(currentUrl)) {
        throw new GraphError(
          502,
          'paging_cycle',
          undefined,
          'Microsoft Graph returned a repeated page link',
        );
      }
      visited.add(currentUrl);
      const page: GraphListResponse<T> = await this.client.get<GraphListResponse<T>>(currentUrl);
      values.push(...page.value);
      currentUrl = page['@odata.nextLink'];
    }
    return values;
  }

  private async pagedDelta(
    folderId: string,
    deltaLinkOrNull: string | null,
  ): Promise<GraphDeltaResponse> {
    const value: GraphMessage[] = [];
    let deltaLink: string | undefined;
    for await (const page of this.messagesDeltaPages(folderId, deltaLinkOrNull)) {
      value.push(...page.value);
      if (page['@odata.deltaLink']) {
        deltaLink = page['@odata.deltaLink'];
      }
    }
    return { value, ...(deltaLink ? { '@odata.deltaLink': deltaLink } : {}) };
  }
}

export function createMailApi(client: PublicClientApplication, homeAccountId: string): MailApi {
  return new MailApi(client, homeAccountId);
}
