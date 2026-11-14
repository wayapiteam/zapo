# Login counter: correção e evidências de preservação

Verificação de 14/11/2026 na branch `chore/upgrade-zapo-1.11-session-safety`.

O campo existente `WaAuthCredentials.loginCounter` agora é salvo e recuperado nos cinco
providers externos. Não houve mudança no protocolo, no incremento do contador ou nos fluxos
de pareamento e logout. A alteração ainda não foi publicada nem aplicada ao WayAPI.

## TDD e implementação

Antes da implementação, os novos testes falharam ao salvar e reler o contador: `undefined`
em vez de `42` nos quatro bancos externos e `undefined` em vez de `0` no SQLite. O gate de
upgrade também reproduziu a perda. Depois da correção, os mesmos contratos passaram.
Os testes foram registrados em um commit separado da implementação.

- SQLite: migração `0021_auth_login_counter`, apenas
  `ALTER TABLE auth_credentials ADD COLUMN login_counter INTEGER`.
- PostgreSQL e MySQL: migração `0022_auth_login_counter`, com coluna `BIGINT` nullable.
- MongoDB e Redis: campo adicional no documento/hash, sem migração de schema.

O SQLite aplica a alteração de schema e seu registro de migração na mesma transação. Não há
`DROP`, `DELETE`, recriação de tabela ou backfill nessa migração. Registros antigos ficam com
`NULL`, recuperado como campo ausente. O core continua usando seu fallback existente para zero
e grava o novo valor após um login bem-sucedido. Não é possível reconstruir contagens antigas.

Os testes cobrem campo ausente, zero, `42`, `4_294_967_296`, atualização, releitura e preservação
das chaves. O ensaio do core também verifica incremento de `43` para `44` no sucesso e ausência
de incremento em uma atualização comum dos atributos.

## Prova local sobre o SQLite usado pelo WayAPI

O gate `scripts/upgrade/credential-upgrade.test.cjs` usa o fork instalado 1.7.1 com SQLite
1.0.1 para criar duas sessões sintéticas em um arquivo temporário. Processos separados usam
as versões antiga e candidata. Nenhum banco ou segredo real é utilizado.

1. **Conteúdo anterior idêntico:** são calculados hashes por tabela de todas as colunas e
   linhas existentes, incluindo BLOBs. Após migrar, os hashes e as contagens permanecem iguais.
   A comparação exclui apenas a nova coluna e o histórico de migrações. Auth, identidade,
   Noise, signed prekey, ADV, prekeys, ratchets Signal e sender keys permanecem legíveis.
2. **Migração repetida:** a coluna e o registro de migração existem uma única vez; repetir a
   abertura não muda o conteúdo anterior.
3. **Rollback de versão:** o provider antigo lê e salva depois da migração. A versão nova
   consegue reler as mesmas chaves e o contador, que o SQL antigo deixa intocado.
4. **Falha após o DDL:** uma falha é injetada depois de executar o `ALTER TABLE`, ainda dentro
   da transação real. A coluna e o registro da migração são desfeitos, todas as linhas
   anteriores continuam iguais, a versão antiga lê o banco e uma nova tentativa funciona.
5. **Conexões durante a migração:** o ensaio é executado com core 1.7.1 e com o candidato 1.11.0.
   Em cada execução, duas conexões reais WebSocket/Noise estão autenticadas em um servidor
   local de teste, usando o provider antigo. Outro provider aplica a migração no mesmo arquivo.
   Quatro consultas IQ, antes e depois, recebem resposta. Há zero eventos de fechamento,
   as duas conexões continuam abertas, a contagem de autenticações permanece em dois e
   as impressões digitais das credenciais são idênticas. O encerramento de limpeza ocorre
   somente depois dessas verificações.
6. **Falhas de processo e leitura:** SIGINT, SIGTERM, SIGKILL em transação não confirmada,
   erro de leitura e arquivo corrompido preservam os contratos dos testes anteriores. A
   limpeza explícita continua funcionando e isolada por sessão.

Isso comprova a preservação nos cenários executados. Não comprova aceitação pelo WhatsApp
real, ausência de toda regressão do upgrade ou continuidade física do socket ao reiniciar
um processo. O servidor local exercita transporte e criptografia reais, mas simula o serviço.

## Resultados

| Validação                                        | Resultado                |
| ------------------------------------------------ | ------------------------ |
| Gate de migração, processos, rollback e conexões | 17 passaram, zero falhas |
| SQLite com `better-sqlite3`                      | 29 passaram, um skip     |
| SQLite com `node:sqlite`                         | 29 passaram, um skip     |
| PostgreSQL 18 real e temporário                  | 37 passaram              |
| MySQL 8 real e temporário                        | 37 passaram              |
| MongoDB real e temporário com replica set        | 35 passaram              |
| Redis 7 real e temporário                        | 39 passaram              |
| Core                                             | 1374 passaram, um skip   |
| Lifecycle do WayAPI, sete arquivos selecionados  | 198 passaram             |

Os bancos externos foram iniciados exclusivamente para a tarefa. O skip do SQLite é o
fallback automático sem addon nativo, pois `better-sqlite3` está instalado neste ambiente.
Não houve skip dos novos contratos do contador.

Também passaram o build CJS/ESM dos cinco providers, o typecheck do core e dos onze pacotes,
o ESLint dos quinze arquivos de código/testes alterados e o `format:check` completo.

A repetição do lifecycle usou o WayAPI local em `561fa7482b66200f160de120f78471928d1ae909`,
com suas alterações locais preexistentes preservadas. O recorte atual tem 198 testes, contra
194 no registro anterior. Os sete arquivos cobrem adapter, eventos, classificação, utilitários,
shutdown do servidor e seleção de instâncias para retomada. Foram usados aliases por projeto
do Vitest para o core/store candidatos e um hook para os subprocessos, com PostgreSQL 18
temporário exclusivo da tarefa. As verificações de SIGINT/SIGTERM preservaram status e
autenticação nos estados `connected` e `connecting`. Esses testes do consumidor controlam
parte do transporte; o ensaio WebSocket/Noise descrito acima é uma prova separada.

## Reprodução

Depois de instalar as dependências e construir o core, construa os dois pacotes necessários
ao gate de persistência e ao servidor local:

```bash
npm run build -w packages/store-sqlite
npm run build -w packages/fake-server
ZAPO_UPGRADE_REFERENCE_MANIFEST=/caminho/wayapi/packages/shared/package.json npm run test:upgrade:persistence
ZAPO_SQLITE_TEST_DRIVER=better-sqlite3 npm test -w packages/store-sqlite
ZAPO_SQLITE_TEST_DRIVER=node npm test -w packages/store-sqlite
```

O manifesto de referência deve continuar resolvendo o fork 1.7.1 e o provider SQLite 1.0.1.
Os testes criam e removem seus próprios arquivos sintéticos. Os testes de integração dos
outros providers usam as variáveis `ZAPO_TEST_*` já utilizadas pelo CI do projeto.

## Limite para a implantação

O `loginCounter` deixa de ser uma pendência. O bloqueio de respostas IQ com oito handlers
continua separado e aberto. O upgrade completo ainda não está liberado para produção.

Uma troca que reinicia o Socket Manager encerra o transporte e precisa retomá-lo com as
credenciais preservadas. A versão do processo atualmente carregado em produção permanece
desconhecida, portanto seu comportamento na primeira parada não foi comprovado. Também é
necessário manter o caminho absoluto do SQLite: um arquivo novo em outro diretório pode
parecer perda de sessão mesmo com o banco original intacto. Esses pontos já foram
identificados na [auditoria de sessões](./upgrade-1.11-session-safety.md).
