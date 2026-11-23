import { useCallback, useMemo } from 'react';
import { AgGridReact } from '@ag-grid-community/react';
import { ModuleRegistry } from '@ag-grid-community/core';
import type { ColDef, GridReadyEvent, IDatasource, IGetRowsParams } from '@ag-grid-community/core';
import { InfiniteRowModelModule } from '@ag-grid-community/infinite-row-model';
import 'ag-grid-community/styles/ag-grid.css';
import 'ag-grid-community/styles/ag-theme-quartz.css';
import { apiService } from '../services/ApiService.js';
import type { MessageRow } from '../services/ApiService.js';

const PAGE_SIZE = 100;
ModuleRegistry.registerModules([InfiniteRowModelModule]);

type EmailGridProps = {
  view: string;
  query: string;
  onOpen: (message: MessageRow) => void;
};

export default function EmailGrid({ view, query, onOpen }: EmailGridProps) {
  const columnDefs = useMemo<ColDef<MessageRow>[]>(
    () => [
      { field: 'fromName', headerName: 'Sender', flex: 1, minWidth: 180 },
      { field: 'subject', headerName: 'Subject', flex: 2, minWidth: 240 },
      {
        field: 'receivedAt',
        headerName: 'Received',
        minWidth: 190,
        valueFormatter: ({ value }) => (value ? new Date(value).toLocaleString() : ''),
      },
    ],
    [],
  );
  const datasource = useMemo<IDatasource>(
    () => ({
      getRows: async (params: IGetRowsParams) => {
        const sort = params.sortModel[0];
        try {
          const result = await apiService.listMessages({
            offset: params.startRow,
            limit: PAGE_SIZE,
            view,
            q: query,
            ...(sort?.colId ? { sort: sort.colId } : {}),
            ...(sort?.sort ? { order: sort.sort } : {}),
          });
          params.successCallback(result.items, result.total);
        } catch {
          params.failCallback();
        }
      },
    }),
    [query, view],
  );
  const onGridReady = useCallback(
    (event: GridReadyEvent<MessageRow>) => {
      event.api.setGridOption('datasource', datasource);
      event.api.sizeColumnsToFit?.();
    },
    [datasource],
  );

  return (
    <div className="email-grid ag-theme-quartz" aria-label="Inbox messages">
      <AgGridReact<MessageRow>
        columnDefs={columnDefs}
        rowModelType="infinite"
        defaultColDef={{ sortable: true, resizable: true }}
        cacheBlockSize={PAGE_SIZE}
        maxBlocksInCache={5}
        onGridReady={onGridReady}
        onRowClicked={({ data }) => { if (data) onOpen(data); }}
        onRowDoubleClicked={({ data }) => { if (data) onOpen(data); }}
        overlayNoRowsTemplate="<span>No cached inbox messages</span>"
      />
    </div>
  );
}
