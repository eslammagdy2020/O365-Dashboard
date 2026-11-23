/** @vitest-environment jsdom */
import React, { useEffect, useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@ag-grid-community/react', () => ({
  AgGridReact: (props: {
    columnDefs: Array<{ field?: string; headerName?: string }>;
    onGridReady: (event: { api: { setGridOption: (key: string, value: unknown) => void } }) => void;
  }) => {
    const TestGrid = () => {
      const [rows, setRows] = useState<Array<Record<string, unknown>>>([]);
      useEffect(() => {
        let datasource:
          | {
              getRows: (params: {
                startRow: number;
                endRow: number;
                sortModel: Array<{ colId: string; sort: string }>;
                successCallback: (rows: Array<Record<string, unknown>>, lastRow?: number) => void;
                failCallback: () => void;
              }) => void;
            }
          | undefined;
        props.onGridReady({
          api: {
            setGridOption: (_key, value) => {
              datasource = value as typeof datasource;
            },
          },
        });
        datasource?.getRows({
          startRow: 0,
          endRow: 100,
          sortModel: [],
          successCallback: (loaded) => setRows(loaded),
          failCallback: () => setRows([]),
        });
      }, []);
      return React.createElement(
        'div',
        { role: 'table' },
        ...props.columnDefs.map((column) =>
          React.createElement(
            'div',
            { role: 'columnheader', key: column.field },
            column.headerName,
          ),
        ),
        ...rows.map((row) =>
          React.createElement(
            'div',
            { role: 'row', key: String(row.id) },
            ...props.columnDefs.map((column) =>
              React.createElement(
                'span',
                { key: column.field },
                String(row[column.field ?? ''] ?? ''),
              ),
            ),
          ),
        ),
      );
    };
    return React.createElement(TestGrid);
  },
}));

import EmailGrid from '../src/components/EmailGrid.js';

afterEach(() => vi.restoreAllMocks());

describe('EmailGrid', () => {
  it('renders rows returned by the inbox list API', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              items: [
                {
                  id: 'message-1',
                  conversationId: 'conversation-1',
                  folderId: 'inbox-id',
                  subject: 'Quarterly update',
                  fromName: 'Sam Example',
                  fromAddress: 'sam@example.invalid',
                  receivedAt: '2026-11-22T10:00:00.000Z',
                  isRead: false,
                  importance: 'normal',
                  hasAttachments: false,
                  flagStatus: 'notFlagged',
                  categories: [],
                  autoCategories: [],
                  baseScore: null,
                  score: null,
                  tier: null,
                  bodyPreview: 'Preview',
                  webLink: '',
                },
              ],
              total: 1,
              offset: 0,
              limit: 100,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
      ),
    );

    render(React.createElement(EmailGrid));

    expect(screen.getByRole('columnheader', { name: 'Sender' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Subject' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Received' })).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Sam Example')).toBeTruthy());
    expect(screen.getByText('Quarterly update')).toBeTruthy();
  });
});
