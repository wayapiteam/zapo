# Revalidação do upgrade após rebase na master do fork

> Atualização de 15/11/2026: a rodada de [cobertura e TDD de IQ](./upgrade-1.11-iq-tdd.md)
> acrescentou cenários antes da correção e reproduziu o bloqueio também com WebSocket/Noise
> local. Os resultados abaixo registram a rodada anterior.

Rodada de 14/11/2026 na branch `chore/upgrade-zapo-1.11-session-safety`.

**Resultado: preservação de credenciais comprovada nos cenários locais executados;
upgrade completo ainda bloqueado para produção pelo gate de IQ.** Não houve acesso a banco,
credenciais ou processos de produção, publicação de pacote ou alteração da master.

## Base e revisões independentes

Foi executado `git fetch origin master` contra `wayapiteam/zapo`. A master local e a remota
apontavam para `99d9d6015718bee26d4830a39be2f9a46f772996`. O comando
`git rebase --rebase-merges master` terminou sem conflitos, preservando a integração upstream
e o conteúdo do candidato `131226ce8731cdc7f3fdfa14fd7224527c5859b5`. Não havia novos commits
na master do fork para incorporar nesta rodada.

Foram solicitadas as revisões independentes dos modelos `gpt-6-luna` e `gpt-6.1-terra`, sobre
esse candidato. Os workers trabalharam sem alteração de código e entregaram os relatórios
sem necessidade de acompanhamento. A correção MySQL descrita abaixo é posterior às revisões;
não deve ser apresentada como já reavaliada por ambos.

- Luna: identificou risco de migração MySQL interrompida após o DDL e antes do marcador,
  além de limites nas provas de schema e interrupção dos testes existentes. A revisão foi
  estática, sem execução independente dos bancos.
- Terra: reproduziu o bloqueio de IQ e demonstrou em ensaio interno que um frame já
  decodificado pode permanecer agendado após reset da conexão. Esse último ensaio não abriu
  sockets e não demonstrou dano real ou regressão introduzida pelo upgrade. Também apontou
  dependência da versão em memória no shutdown, caminho do banco e limites do phash explícito.

## Correção adicional orientada por teste: MySQL

O teste novo reproduziu o estado durável de uma interrupção: coluna `login_counter` existente,
sem o marcador `0022_auth_login_counter`. Na implementação anterior, a tentativa seguinte
falhou com `ER_DUP_FIELDNAME`. Essa falha foi registrada antes da correção.

O executor agora recupera somente essa migração e esse erro, após consultar o schema real e
confirmar uma coluna `BIGINT`, nullable, sem default ou geração especial. A recuperação grava
o marcador, sem regravar credenciais. Coluna incompatível continua causando erro; outros
erros e migrações não recebem essa exceção.

O teste passou com duas tentativas concorrentes, exatamente um marcador e todas as linhas
de duas sessões idênticas antes/depois, incluindo os contadores 42 e 43. Outro teste confirma
rejeição de uma coluna `VARCHAR` sem marcar a migração como aplicada. O estado pós-interrupção
é construído em tabelas sintéticas com prefixo exclusivo; esse teste não mata um processo
durante DDL MySQL nem afirma ausência de toda janela de falha.

## Resultados desta rodada

| Validação                                                 | Resultado                          |
| --------------------------------------------------------- | ---------------------------------- |
| Build do core CJS/ESM/types                               | Passou                             |
| Build dos cinco stores e fake-server                      | Passou                             |
| Core                                                      | 1374 passaram, um skip             |
| Gate de preservação, migração, rollback e conexões locais | 17 passaram                        |
| SQLite nativo                                             | 29 passaram, um skip               |
| SQLite `node:sqlite`                                      | 29 passaram, um skip               |
| PostgreSQL 18 temporário                                  | 37 passaram                        |
| Redis 7 temporário                                        | 39 passaram                        |
| MongoDB temporário com replica set                        | 35 passaram                        |
| MySQL 8 temporário com a correção de recuperação          | 39 passaram                        |
| Lifecycle do WayAPI, sete arquivos                        | 198 passaram                       |
| Gate da fila                                              | Um passou, um falhou: IQ bloqueado |

O skip do SQLite corresponde ao fallback sem addon nativo, indisponível porque o addon está
instalado. O gate de credenciais não tem skip. A suíte do core e o gate de fila são separados:
o core verde não torna o gate de fila verde.

A implementação MySQL corrigida também passou build CJS/ESM, typecheck e ESLint dos arquivos
alterados. Os resultados de build e testes dos outros componentes permanecem válidos porque
não houve mudança em seu código após essas execuções.

## O que foi comprovado sobre o banco e as conexões

O gate usa o fork 1.7.1 e SQLite 1.0.1 instalados como referência, cria duas sessões sintéticas
e usa processos separados para migração, releitura e rollback. A comparação completa dos
valores e contagens das linhas anteriores exclui apenas a nova coluna e o histórico de
migrações. Não é uma comparação integral de todos os objetos do schema, índices e triggers.

Chaves Noise, identidade, signed prekey, ADV, identidade assinada, routing info e chave do
servidor, além de prekeys, identidade remota, ratchets Signal e sender keys, continuam legíveis.
A migração SQLite apenas adiciona uma coluna nullable; não recria nem esvazia a tabela de
auth. Falha injetada após executar o DDL causa rollback da coluna e do marcador, mantendo as
linhas antigas. Repetir a migração e voltar ao provider antigo também preserva os dados.

O ensaio de conexões foi repetido com core 1.7.1 e candidato 1.11.0. Em cada caso, duas conexões
WebSocket/Noise autenticadas em servidor local simulado receberam quatro respostas IQ,
sem fechamento ou nova autenticação durante a migração no mesmo arquivo SQLite. A limpeza
deliberada dos testes acontece depois dessas verificações.

Os sete arquivos do WayAPI passaram usando core/store candidatos, aliases por projeto e
hook nos subprocessos. Os casos de SIGINT/SIGTERM nos estados `connected` e `connecting`
preservaram status durável e autenticação. O PostgreSQL desses testes é temporário e exclusivo
desta tarefa. Limpezas de schema ou tabelas nos fixtures não são operações de produção.

## Impedimentos para recomendar produção

1. O gate exige oito IQ concluídos antes do timeout e observou zero. Esse bloqueio também
   foi caracterizado na versão antiga, mas permanece no candidato e precisa ser corrigido.
2. O ensaio de frames já agendados após reset merece um contrato de comportamento e um
   teste com transporte e efeitos de handlers; seu efeito operacional ainda não foi comprovado.
3. A versão em execução em produção permanece desconhecida. O shutdown da versão antiga
   determina a primeira troca; código novo no disco não modifica o processo antigo em memória.
4. O caminho efetivo do SQLite precisa permanecer o mesmo. Um cwd diferente pode abrir um
   arquivo novo, aparentando perda de sessão mesmo com o banco original intacto.
5. Os bundles de protocolo e uma sessão WhatsApp real não foram validados nesta rodada.
   Pareamento, retomada e um canário controlado continuam necessários antes da liberação.

Reiniciar um processo fecha seu transporte. A prova local é de preservação de credenciais e
de convivência com a alteração de schema, não de continuidade física do socket durante deploy
nem de ausência universal de regressões em produção.

Os comandos de reprodução de persistência estão no
[relatório do contador](./upgrade-1.11-login-counter.md). O gate restante é executado com
`npm run test:upgrade:queue`; sua falha não foi removida nem convertida em sucesso esperado.
