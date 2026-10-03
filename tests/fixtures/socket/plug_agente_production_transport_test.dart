import 'dart:async';
import 'dart:io';
import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:odbc_fast/odbc_fast.dart';
import 'package:plug_agente/application/services/protocol_negotiator.dart';
import 'package:plug_agente/core/config/feature_flags.dart';
import 'package:plug_agente/core/settings/app_settings_store.dart';
import 'package:plug_agente/domain/protocol/protocol.dart';
import 'package:plug_agente/domain/repositories/i_rpc_request_dispatcher.dart';
import 'package:plug_agente/domain/repositories/i_rpc_stream_emitter.dart';
import 'package:plug_agente/infrastructure/codecs/rpc_stream_columnar_chunk_codec.dart';
import 'package:plug_agente/infrastructure/codecs/transport_work_pool.dart';
import 'package:plug_agente/infrastructure/datasources/socket_data_source.dart';
import 'package:plug_agente/infrastructure/external_services/socket_io_transport_client_v2.dart';
import 'package:plug_agente/infrastructure/security/payload_signer.dart';
import 'package:result_dart/result_dart.dart';

/// Real production transport with a deterministic SQL gateway, not ODBC.
class _GatewayDispatcher implements IRpcRequestDispatcher {
  _GatewayDispatcher(this.producer);
  final StreamProducer? producer;
  final finished = Completer<void>();
  @override
  Future<RpcResponse> dispatch(
    RpcRequest request,
    String agentId, {
    String? clientToken,
    IRpcStreamEmitter? streamEmitter,
    TransportLimits? limits,
    Map<String, dynamic> negotiatedExtensions = const {},
  }) async {
    final emitter = streamEmitter!;
    unawaited(
      _produce(request.id, emitter).catchError((
        Object error,
        StackTrace stack,
      ) {
        if (!finished.isCompleted) finished.completeError(error, stack);
      }),
    );
    return RpcResponse.success(
      id: request.id,
      result: {'stream_id': 'production-stream', 'rows': <Object>[]},
    );
  }

  Future<void> _produce(dynamic id, IRpcStreamEmitter emitter) async {
    await Future<void>.delayed(const Duration(milliseconds: 100));
    if (producer case final produce?) {
      await produce(id, emitter);
      if (!finished.isCompleted) finished.complete();
      return;
    }
    final random = Random(42);
    for (var index = 0; index < 24; index++) {
      final result = toTypedColumnar(
        QueryResult(
          columns: const ['n', 'value', 'nullable'],
          rows: List.generate(
            64,
            (row) => <dynamic>[
              index * 64 + row,
              List.generate(
                1024,
                (_) => String.fromCharCode(33 + random.nextInt(80)),
              ).join(),
              row.isEven ? null : 'ação 漢字',
            ],
          ),
          rowCount: 64,
        ),
      );
      final accepted = await emitter.emitChunk(
        RpcStreamChunk(
          streamId: 'production-stream',
          requestId: id,
          chunkIndex: index,
          rows: const [],
          columnar: RpcStreamColumnarChunkCodec.encodeTypedColumnarResult(
            result,
          ),
        ),
      );
      if (!accepted) throw StateError('Unexpected stream admission failure');
    }
    await emitter.emitComplete(
      RpcStreamComplete(
        streamId: 'production-stream',
        requestId: id,
        totalRows: 1536,
      ),
    );
    if (!finished.isCompleted) finished.complete();
  }

  @override
  Future<void> cancelActiveStreamOnDisconnect() async {}
  @override
  Future<Result<void>> cancelActiveSqlOnDisconnect() async =>
      const Success(unit);
}

typedef StreamProducer = Future<void> Function(
  dynamic id,
  IRpcStreamEmitter emitter,
);

void main() => runProductionTransportTest();

void runProductionTransportTest({
  StreamProducer? producer,
  Future<void> Function()? cleanup,
}) {
  TestWidgetsFlutterBinding.ensureInitialized();
  test(
    'production Dart transport streams columnar SQL through the hub',
    () async {
      final flags = FeatureFlags(InMemoryAppSettingsStore());
      await flags.setEnablePayloadSigning(true);
      final dispatcher = _GatewayDispatcher(producer);
      final transport = SocketIOTransportClientV2(
        dataSource: SocketDataSource(),
        negotiator: ProtocolNegotiator(),
        rpcDispatcher: dispatcher,
        featureFlags: flags,
        options: SocketIOTransportClientV2Options(
          payloadSigner: PayloadSigner(
            keys: {
              Platform.environment['PLUG_BRIDGE_E2E_KEY_ID']!:
                  Platform.environment['PLUG_BRIDGE_E2E_KEY']!,
            },
          ),
        ),
      );
      try {
        final result = await transport.connect(
          Platform.environment['PLUG_BRIDGE_E2E_URL']!,
          'agent-dart-bridge-test',
          authToken: 'bridge-test-token',
        );
        expect(
          result.isSuccess(),
          isTrue,
          reason: result.exceptionOrNull()?.toString(),
        );
        await dispatcher.finished.future.timeout(const Duration(seconds: 20));
        await Future<void>.delayed(const Duration(milliseconds: 500));
      } finally {
        await transport.disconnect();
        await TransportWorkPool.shared.dispose();
        await cleanup?.call();
      }
    },
    timeout: const Timeout(Duration(seconds: 30)),
  );
}
