import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;
import 'package:plug_agente/infrastructure/codecs/transport_pipeline.dart';
import 'package:plug_agente/infrastructure/security/payload_signer.dart';

void main() {
  test('agent codec handles the shared hub catalog and canonical HMAC', () async {
    final fixtureDir = Platform.environment['PLUG_SERVER_FIXTURE_DIR'];
    expect(fixtureDir, isNotNull, reason: 'PLUG_SERVER_FIXTURE_DIR is required');
    final file = File(p.join(fixtureDir!, 'agent_inbound_catalog.json'));
    expect(file.existsSync(), isTrue, reason: 'Hub contract catalog is missing');
    final catalog = jsonDecode(file.readAsStringSync()) as Map<String, dynamic>;
    final frames = Map<String, dynamic>.from(catalog['frames'] as Map);
    final signer = PayloadSigner(
      keys: {catalog['hmacKeyId'] as String: catalog['hmacTestKey'] as String},
    );
    final none = TransportPipeline(encoding: 'json', compression: 'none');
    final gzip = TransportPipeline(
      encoding: 'json',
      compression: 'gzip',
      compressionThreshold: 1,
    );

    for (final name in [
      'agentRegister',
      'agentCapabilities',
      'agentReady',
      'unaryResponse',
      'streamOpen',
      'streamChunk',
      'streamComplete',
      'terminalError',
      'retryResponse',
      'takeoverRegister',
    ]) {
      final body = frames[name];
      for (final pipeline in [none, gzip]) {
        final frame = (await pipeline.prepareSendAsync(
          body,
          requestId: 'fixture-$name',
        )).getOrThrow();
        expect((await pipeline.receiveProcessAsync(frame)).getOrThrow(), body);
        final signature = signer.signFrame(frame);
        expect(signer.verifyFrame(frame, signature), isTrue);
        final tampered = frame.copyWith(requestId: 'different-request-id');
        expect(signer.verifyFrame(tampered, signature), isFalse);
      }
    }
  });
}
