# Entrada: 12 handlers e 4096 aguardando

17/11/2026. Branch `chore/upgrade-zapo-1.11-session-safety`.
O novo padrão é **12 callbacks ativos por geração de conexão e 4096 aguardando**.
A alteração está na branch do fork; não foi feito merge na master, publicação ou deploy.

## Por que mudar apenas a concorrência

O [experimento anterior](./incoming-queue-limits.md) comparou 8/4096, 12/4096, 8/6144 e
12/6144. Doze callbacks melhoraram a carga sintética que aguardava I/O, enquanto aumentar
só a fila não acelerou o lote e reteve mais memória. Por isso, o fork adota 12/4096.
Isso não promete o mesmo ganho em produção: banco, locks e CPU podem limitar o throughput.

O runtime muda uma constante em `WaComms`. A criação inicial e a substituição da fila por
geração usam a mesma constante. Não há nova opção pública, outra fila ou novo protocolo.
Os budgets continuam separados e limitados por geração, sem promessa de teto global de RSS:

| Recurso                                   | Padrão atual                 |
| ----------------------------------------- | ---------------------------- |
| Handlers normais ativos                   | 12                           |
| Callbacks normais aguardando              | 4096                         |
| Chunks wire admitidos, ativos e esperando | 4108, derivados de 12 + 4096 |
| Wire retido                               | 64 MiB                       |
| Corpos preparados, ativos e esperando     | 64 MiB                       |
| Frames pré-ready                          | 2048 / 16 MiB                |

A antecipação de IQ result/error pendente continua antes da fila normal. Decodificação,
correlação, filtros e receipts mantêm os contratos do [patch IQ](./upgrade-1.11-iq-fix.md).
Não se altera persistência, migrações, caminho do banco ou limpeza de credenciais.

## TDD e fronteiras

O commit `7ed29ba` acrescentou/ajustou os testes antes do incremento de runtime (`998bd67`).
Com oito vagas, os testes produziram cinco falhas no arquivo WaComms, sete no gate de fila
e uma falha no novo caso de doze handlers com WebSocket/Noise. Não eram treze defeitos
independentes: exigiam a capacidade nova e seu isolamento nos caminhos existentes.

Os contratos agora verificam:

- Doze callbacks começam; o décimo terceiro só inicia quando uma vaga termina.
- Uma falha entre os doze libera a vaga para o próximo e somente a reserva de bytes do
  callback que falhou. O erro continua observável, sem perder as demais reservas.
- Há exatamente 4096 lugares de espera além dos doze ativos. Cinco excedentes provocam
  apenas uma retomada. A fronteira de wire é verificada antes e depois do excesso.
- Doze IQs pendentes concluem antes do timeout com 4096 frames normais aguardando,
  incluindo result/error, ordem inversa e IDs desconhecidos/ausentes/duplicados.
- Uma resposta omitida expira sozinha; as outras onze concluem.
- Fila cheia da geração antiga, callbacks e orçamentos não contaminam a conexão nova.
- Durante reset com 16 callbacks preparados, quatro aguardando são cancelados e apenas
  os doze já ativos mantêm suas reservas até terminarem.
- Os budgets de 64 MiB continuam valendo antes de atingir o limite de itens, incluindo
  input comprimido. A reserva é liberada após conclusão, rejeição ou cancelamento.

Os gates preservam os cenários anteriores com sete/oito handlers e acrescentam as novas
fronteiras de onze/doze. Isso evita deixar um teste de "saturação" usando só oito vagas
depois de aumentar o limite para doze.

## Integração e validação local

| Verificação                                                           | Resultado                       |
| --------------------------------------------------------------------- | ------------------------------- |
| WaComms, incluindo erro e liberação de vaga/reserva                   | 17 passaram                     |
| Core completo, instrumentado com c8                                   | 1427 passaram, um skip anterior |
| Gate controlado da fila                                               | 13 passaram                     |
| WebSocket/Noise local                                                 | 30 passaram                     |
| Fake-server completo                                                  | 217 passaram                    |
| Persistência com core 1.7.1 e SQLite 1.0.1 instalados no WayAPI local | 17 passaram                     |
| WayAPI, sete arquivos de lifecycle, com core/provider candidatos      | 198 passaram                    |
| Publisher com executor falso e tarballs CJS/ESM + SQLite              | 6 + 1 passaram                  |
| Build CJS/ESM/types e typechecks core/exemplos/bench/11 pacotes       | Passaram                        |
| Estrutura de testes e lint do repositório                             | Passaram                        |

Os 30 casos de loopback passam por `WaClient`, Noise/codec reais e servidor sintético em
loopback, cobrindo compressão, filtros, `ignoreKey`, retries, drain, erros de handler e
dados/envios antigos após reconexão com ID reutilizado. Os testes de doze IQs exigem uma
autenticação e nenhum fechamento para resolver saturação; o drain fecha deliberadamente.
O ensaio de geração antiga reconecta deliberadamente e confere o fingerprint das chaves.
Um novo caso fecha a combinação indicada pelo revisor: transmite 4096 notificações por
WebSocket/Noise enquanto doze handlers aguardam IQ, confere a fila física com 12 ativos e
4096 pendentes, entrega as respostas, drena as 4096 notificações em FIFO e compara as chaves
persistidas antes/depois. Passou sem timeout, reautenticação ou fechamento da conexão.

A matriz WayAPI usa aliases e hook para subprocessos, e probes verificam em runtime tanto
12/4096 no core carregado quanto a identidade do provider SQLite candidato. Usou PostgreSQL
18 temporário dedicado, removido depois, e bancos SQLite temporários. Não acessou banco de
produção nem alterou a dependência ou fontes do consumidor. Passaram as verificações de
SIGINT/SIGTERM em connected/connecting e retomada no startup.

O job `test-fake-server` do CI já exige os dois gates de upgrade. Os testes unitários novos
entram no comando normal do core. O benchmark foi adaptado para reconhecer constantes do
build atual, selecionar fixtures compatíveis com cada perfil e incluir 12/4096 no loopback.

## A cobertura é boa?

A suíte unitária do core cobre **84,78% das linhas, 80,20% dos ramos e 89,72% das funções**.
O recorte segue as exclusões usuais do projeto: declarações, testes, arquivos `types.ts` e
contratos de store. Não inclui optional packages, WhatsApp real nem os gates que executam
`dist`; esses testes são registrados separadamente, sem somar percentuais incompatíveis.

| Arquivo                  | Linhas | Ramos  |
| ------------------------ | ------ | ------ |
| `BoundedTaskQueue.ts`    | 98,97% | 93,93% |
| `WaNodeOrchestrator.ts`  | 95,20% | 84,37% |
| `WaNodeTransport.ts`     | 99,09% | 88,57% |
| `WaConnectionManager.ts` | 81,04% | 72,72% |
| `WaComms.ts`             | 73,61% | 77,16% |
| `WaNoiseSession.ts`      | 60,80% | 66,00% |
| `WaClient.ts`            | 53,73% | 59,57% |

Há boa cobertura dos contratos de fila/correlação e casos negativos reais. Ela ainda é
parcial na orquestração do cliente, Noise e recuperação de conexão. Os gates de integração
exercitam caminhos além dessa medição unitária, mas não autorizam anunciar 100% de cobertura
ou ausência de regressões. O teste adicional de falha entre doze callbacks protege uma
combinação importante mesmo sem aumentar o percentual global: esses ramos já apareciam
em outros cenários, mas isso não comprovava a capacidade e o orçamento sob essa combinação.

Continuam como prioridades: sessões reais de pareamento/restart/rollback em canário,
falhas reais de rede durante handshake/retomada, efeitos de I/O de um handler antigo já
iniciado e shutdown com persistência que demora ou não termina. Múltiplas instâncias
também podem pressionar banco/crypto ao admitir quatro operações simultâneas extras cada.

Filtros raw arbitrários continuam no caminho normal: doze handlers esperando respostas
podem esgotá-lo. Aumentar o limite não corrige esse fallback; `ignoreKey` conserva o caminho
antecipado. Callbacks já iniciados não são cancelados à força, e os limites são por geração.

## Revisão independente e evidências

Foi solicitada revisão em checkout isolado do SHA `998bd67`, sem herdar conclusões da
implementação. O relatório externo e os resultados próprios ficam em
`avaliacao-upgrade-zapo/concurrency-12-2026-11-17/review-independent.md`.
O revisor executou build próprio e 78 testes focados, incluindo seis testes seus de
fronteiras, preparador real, FIFO, filtros, budgets por geração e falha de callback. Não
demonstrou defeito funcional novo. Apontou dois itens P3: documentação ainda citando oito
handlers e seletor do benchmark omitindo 12/4096. Ambos foram corrigidos depois da revisão.
A lacuna de WebSocket/Noise +4096 no mesmo ensaio também foi fechada pelo novo teste acima.
O relatório independente preserva seu SHA e limites, sem atribuir os testes do agente
principal a uma execução própria. As evidências locais incluem logs, cobertura JSON e
manifesto com SHAs/checksums.

Não houve validação com WhatsApp real. Antes de liberar, conferir processo antigo e seu
shutdown, caminhos do banco e backup, e fazer canário comparando CPU, heap/RSS, backlog,
tempo de banco, timeouts IQ e reconexões com o baseline. Reiniciar um processo encerra o
socket físico; os testes de preservação verificam retomada da sessão, não um socket eterno.
