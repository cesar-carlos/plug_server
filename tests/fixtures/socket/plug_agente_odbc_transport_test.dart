import 'dart:io';

import 'package:flutter_dotenv/flutter_dotenv.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:odbc_fast/odbc_fast.dart';
import 'package:plug_agente/core/settings/app_settings_store.dart';
import 'package:plug_agente/domain/protocol/protocol.dart';
import 'package:plug_agente/infrastructure/external_services/odbc_streaming_gateway.dart';
import 'package:plug_agente/infrastructure/settings/odbc_connection_settings.dart';

import 'plug_agente_production_transport_test.dart';

void main() {
  ServiceLocator? locator;
  runProductionTransportTest(
    producer: (id, emitter) async {
      final file = File('.env');
      if (file.existsSync())
        dotenv.loadFromString(envString: file.readAsStringSync());
      for (final name in [
        'ODBC_STREAM_COLUMNAR_WIRE',
        'ODBC_STREAM_WIRE_ONLY',
        'RPC_CHUNK_COLUMNAR_GZIP_ENABLED',
      ]) {
        if (Platform.environment[name] case final value?)
          dotenv.env[name] = value;
      }
      final dsn =
          [
                'ODBC_E2E_RPC_DSN',
                'ODBC_TEST_DSN',
                'ODBC_DSN',
                'ODBC_TEST_DSN_SQL_SERVER',
                'ODBC_TEST_DSN_POSTGRESQL',
              ]
              .map(
                (name) =>
                    Platform.environment[name] ??
                    (dotenv.isInitialized ? dotenv.env[name] : null),
              )
              .whereType<String>()
              .where((value) => value.trim().isNotEmpty)
              .firstOrNull;
      expect(dsn, isNotNull, reason: 'A real ODBC test DSN is required');
      final settings = OdbcConnectionSettings(InMemoryAppSettingsStore());
      locator = ServiceLocator()..initialize(useAsync: true);
      expect((await locator!.asyncService.initialize()).isSuccess(), isTrue);
      final gateway = OdbcStreamingGateway(locator!.asyncService, settings);
      var index = 0;
      var rows = 0;
      Future<void> sendChunk(
        List<Map<String, dynamic>> rowMaps, {
        Map<String, dynamic>? columnar,
      }) async {
        rows += columnar?['row_count'] as int? ?? rowMaps.length;
        final accepted = await emitter.emitChunk(
          RpcStreamChunk(
            streamId: 'production-stream',
            requestId: id,
            chunkIndex: index++,
            rows: rowMaps,
            columnar: columnar,
          ),
        );
        if (!accepted) throw StateError('ODBC stream admission failed');
      }

      final result = await gateway.executeQueryStream(
        'SELECT 1 AS n',
        dsn!,
        // Some real drivers deliberately select row-major streaming. Both
        // gateway callbacks must feed the same production transport.
        sendChunk,
        fetchSize: 1,
        columnarWireOnly: true,
        onWireChunk: (wire) async {
          expect(wire.columnar, isNotNull);
          await sendChunk(wire.rows, columnar: wire.columnar);
        },
      );
      expect(rows, 1, reason: 'The real SELECT must reach the transport');
      expect(
        result.isSuccess(),
        isTrue,
        reason: 'Real ODBC streaming smoke failed',
      );
      await emitter.emitComplete(
        RpcStreamComplete(
          streamId: 'production-stream',
          requestId: id,
          totalRows: rows,
        ),
      );
    },
    cleanup: () async {
      locator?.shutdown();
    },
  );
}
