import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:plug_agente/infrastructure/codecs/payload_frame.dart';
import 'package:plug_agente/infrastructure/codecs/transport_pipeline.dart';
import 'package:plug_agente/infrastructure/security/payload_signer.dart';
import 'package:socket_io_client/socket_io_client.dart' as io;

void main() {
  test('Dart agent delivers a signed stream through the Node Socket.IO bridge', () async {
    final url = Platform.environment['PLUG_BRIDGE_E2E_URL'];
    final requestId = Platform.environment['PLUG_BRIDGE_E2E_REQUEST_ID'];
    final key = Platform.environment['PLUG_BRIDGE_E2E_KEY'];
    final keyId = Platform.environment['PLUG_BRIDGE_E2E_KEY_ID'];
    expect(url, isNotNull);
    expect(requestId, isNotNull);
    expect(key, isNotNull);
    expect(keyId, isNotNull);

    final none = TransportPipeline(encoding: 'json', compression: 'none');
    final gzip = TransportPipeline(
      encoding: 'json',
      compression: 'gzip',
      compressionThreshold: 1,
    );
    final signer = PayloadSigner(keys: {keyId!: key!});
    Future<Map<String, dynamic>> signedFrame(
      TransportPipeline pipeline,
      Map<String, dynamic> body,
    ) async {
      final frame = (await pipeline.prepareSendAsync(
        body,
        requestId: requestId,
      )).getOrThrow();
      final signature = signer.signFrame(frame);
      return frame.copyWith(signature: signature.toJson()).toSocketPayload();
    }

    final socket = io.io('$url/agents', <String, dynamic>{
      'transports': ['websocket'],
      'autoConnect': false,
      'reconnection': false,
      'auth': {'token': 'bridge-test-token'},
    });
    final finished = Completer<void>();
    socket.on('connect_error', (dynamic error) {
      if (!finished.isCompleted) {
        finished.completeError(StateError('Socket connect_error: $error'));
      }
    });
    socket.on('connection:ready', (dynamic _) async {
      try {
        socket.emit(
          'agent:register',
          await signedFrame(none, {
            'agentId': 'agent-dart-bridge-test',
            'timestamp': DateTime.now().toUtc().toIso8601String(),
            'capabilities': {
              'protocols': ['jsonrpc-v2'],
              'encodings': ['json'],
              'compressions': ['none', 'gzip'],
              'extensions': <String, dynamic>{},
              'limits': <String, dynamic>{},
            },
          }),
        );
      } on Object catch (error, stack) {
        if (!finished.isCompleted) finished.completeError(error, stack);
      }
    });
    socket.on('rpc:request', (dynamic raw) async {
      try {
        final request =
            (await none.receiveProcessAsync(
                  PayloadFrame.fromJson(Map<String, dynamic>.from(raw as Map)),
                )).getOrThrow()
                as Map;
        expect(request['id'], requestId);
        final acked = Completer<void>();
        socket.emitWithAck(
          'rpc:response',
          await signedFrame(gzip, {
            'jsonrpc': '2.0',
            'id': requestId,
            'result': {'stream_id': 'stream-dart-bridge', 'blob': 'x' * 8192},
          }),
          ack: ([dynamic _]) {
            if (!acked.isCompleted) acked.complete();
          },
        );
        for (var index = 0; index < 2; index += 1) {
          socket.emit(
            'rpc:chunk',
            await signedFrame(none, {
              'request_id': requestId,
              'stream_id': 'stream-dart-bridge',
              'chunk_index': index,
              'rows': [
                {'n': index},
              ],
            }),
          );
        }
        socket.emit(
          'rpc:complete',
          await signedFrame(none, {
            'request_id': requestId,
            'stream_id': 'stream-dart-bridge',
            'total_rows': 2,
          }),
        );
        await acked.future.timeout(const Duration(seconds: 10));
        if (!finished.isCompleted) finished.complete();
      } on Object catch (error, stack) {
        if (!finished.isCompleted) finished.completeError(error, stack);
      }
    });

    socket.connect();
    try {
      await finished.future.timeout(const Duration(seconds: 15));
      await Future<void>.delayed(const Duration(milliseconds: 250));
    } finally {
      socket.dispose();
    }
  }, timeout: const Timeout(Duration(seconds: 20)));
}
