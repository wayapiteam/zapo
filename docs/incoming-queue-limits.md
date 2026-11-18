# Experimento: 8/4096 contra 12/6144 na entrada

> Estado posterior: o fork adotou 12/4096. Veja a [implementação e validação](./incoming-concurrency-12.md).
> As medições abaixo são do experimento anterior à adoção e preservam seu baseline histórico.

17/11/2026. Base: `8ecc050`, branch `chore/upgrade-zapo-1.11-session-safety`.
O experimento altera só duas constantes em cópias temporárias do build. Os padrões do
runtime naquela rodada continuavam em oito handlers ativos e 4096 aguardando. Não houve deploy ou publicação.

## Resultado e recomendação

Doze handlers ajudaram no cenário que espera I/O, sem ganho no trabalho limitado por CPU.
Aumentar só a fila não acelerou o mesmo lote. Minha recomendação é experimentar 12/4096
primeiro em uma máquina controlada e considerar 6144 pendentes se houver evidência de
rajadas excedendo a capacidade de espera. Isso separa concorrência de retenção de backlog.
Os resultados não promovem 12/6144 automaticamente para todas as instâncias do fork.

| Ativos / esperando | Lote com I/O, ms | Lote com CPU, ms | Heap + ArrayBuffers adicionais com a fila cheia, MiB |
| ------------------ | ---------------- | ---------------- | ---------------------------------------------------- |
| 8 / 4096           | 300,5 / 305,8    | 21,9 / 22,3      | 40,1 / 40,2                                          |
| 12 / 4096          | 203,1 / 201,7    | 22,5 / 22,0      | 40,2 / 40,2                                          |
| 8 / 6144           | 300,6 / 302,4    | 22,1 / 22,5      | 58,0 / 58,0                                          |
| 12 / 6144          | 205,2 / 209,2    | 22,0 / 22,4      | 54,5 / 57,6                                          |

Cada valor de tempo é a mediana de cinco amostras em um processo; a tabela mostra duas
execuções por perfil, com ordem invertida na segunda. Cada lote tem 1024 eventos de 4 KiB.
O cenário I/O aguarda um timer de 2 ms por handler, representando uma espera externa; não
executa consultas reais a banco. O cenário CPU calcula oito hashes SHA-256 por handler.
Não são mensagens WhatsApp de produção nem medição de throughput de um banco real.

Com doze handlers, o lote I/O levou aproximadamente um terço menos tempo. O trabalho CPU
ficou perto de 22 ms em todos os perfis. A CPU total consumida por lote CPU variou entre
28,2 e 29,3 ms; por lote I/O entre 23,0 e 31,6 ms. Não se observou uma explosão de CPU
neste cenário, mas isso não estima o impacto de mais requisições sobre um banco ocupado.

A métrica de memória é a diferença de heap e ArrayBuffers antes/depois da admissão de um
backlog completo, amostrada após GC. Cada evento desse cenário tem corpo próprio de 4 KiB;
o encoder pode reter buffers com capacidade maior que o payload. As variações refletem
também GC/allocator: não são tamanho exato de cada evento nem pico contínuo de alocação.
Para 12/6144, houve aproximadamente 14 a 18 MiB extras de heap + buffers em relação a 8/4096.
O RSS observado foi cerca de 172 MiB para 8/4096 e 190 a 203 MiB para 12/6144, incluindo o
runtime, aquecimento e outras fases do benchmark. Não extrapolar RSS linearmente por sessão.

## Limites e custos

Os dois números propostos aumentam 50%, mas têm efeitos diferentes:

- Concorrência 8 -> 12 permite mais quatro handlers aguardando I/O por geração de cada
  conexão. Pode aumentar em 50% as operações simultâneas contra dependências. Se banco,
  locks ou crypto já forem o gargalo, isso pode aumentar contenção em vez de throughput.
- Pendentes 4096 -> 6144 retêm até mais 2048 eventos pequenos. A fila maior absorve uma
  rajada adicional; não resolve chegada sustentada acima da capacidade de processamento.
  Pode fazer eventos esperarem mais antes do início do tratamento.
- O limite derivado de wire, contando chunks em processamento ou esperando, passa de
  4104 para 6156 no perfil 12/6144. Chunks WebSocket não equivalem necessariamente a eventos.
- Os limites de bytes de wire e de corpos preparados permanecem em 64 MiB, separados,
  por geração. O buffer pré-ready permanece em 2048 frames / 16 MiB.
- Com eventos grandes, bytes vencem antes da contagem. Nos quatro perfis, payloads de
  64 KiB atingiram o limite preparado com 1023 eventos retidos, sem chegar a 4096 ou 6144.
  A reserva foi liberada após a drenagem. Os tetos não são um limite global de RSS.

A antecipação das respostas IQ foi preservada. Com a fila normal totalmente cheia, oito
ou doze consultas receberam suas respostas em ordem inversa e concluíram sem timeout nem
retomada para desobstruir a fila. As respostas levaram 0,4 a 0,8 ms até conclusão neste
ensaio de componentes; decriptação e rede são sintéticas nessa medição.

Cinco eventos excedentes provocaram uma retomada em cada perfil, mantendo o limite.
Aumentar a capacidade não elimina a necessidade de backpressure. Filtros raw arbitrários
continuam desativando o caminho antecipado de IQ: mais vagas apenas deslocam o ponto
em que todas podem ficar aguardando, não corrigem esse ciclo de dependência.

## Como foi executado

O script `bench/incoming-queue.bench.cjs` copia `dist` para um diretório temporário e altera
somente as constantes de concorrência/contagem no `WaComms.js` copiado. Dependências,
spec e fake-server são ligados ao checkout de origem. A fila é a implementação real,
inclusive a derivação do limite de wire e os budgets de bytes. Os diretórios temporários
são removidos em `finally`; as fontes e o build original não são modificados.

Cada perfil é executado em outro processo Node v24.15.0, com duas amostras de aquecimento
e cinco medidas por tipo de carga. A espera de conclusão da carga I/O usa Promise, sem
polling contínuo que inflaria a CPU. Os perfis são 8/4096, 12/4096, 8/6144 e 12/6144; a
segunda rodada inverte a ordem. Logs diagnósticos da primeira versão do ensaio com polling
não foram usados na tabela final.

Além do benchmark, 8/4096 e 12/6144 executaram 20 casos cada com `WaClient` e fake-server em
loopback WebSocket/Noise. Os 16 casos existentes foram preservados, incluindo filtros,
retries, geração antiga, ID reutilizado e rejeição tardia de envio. Quatro fixtures adicionais
exigem todas as vagas do perfil ocupadas: IQ normal, comprimido, `ignoreKey` e drain.
Todos passaram. Os casos de filtros raw ativos continuam abaixo da saturação e não
comprovam progresso com oito ou doze handlers bloqueados por filtros arbitrários.

Reprodução, a partir de um build atual:

```bash
npm run build
npm run build -w packages/fake-server
node --expose-gc bench/incoming-queue.bench.cjs > incoming-queue-comparison.json
```

O JSON contém perfis, métricas, hashes dos módulos experimentais e logs dos testes de
loopback. As evidências desta rodada estão em
`avaliacao-upgrade-zapo/incoming-limits-2026-11-17`. Não foi executada a suíte completa do
core contra 12/6144, pois esse perfil ainda não é o padrão da branch.

Antes de adotar novos padrões, atualizar os testes com fronteiras fixas de 8/4096,
confirmar descarte de geração e retomada única em 12/6144, e rodar os gates completos do
upgrade. Em seguida, comparar em canário CPU, heap/RSS, latência de início de handler,
profundidade/overflow, tempo de banco, timeouts IQ e reconexões sob carga representativa.
Nenhuma validação local aqui garante que o gargalo de uma instalação real seja I/O.
