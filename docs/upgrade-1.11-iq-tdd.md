# IQ: cobertura existente e contratos antes da correção

Rodada de 15/11/2026 em `chore/upgrade-zapo-1.11-session-safety`, a partir de `3aa8683`.
Esta rodada altera somente testes, seus helpers/comandos e documentação. Não implementa
o caminho antecipado de respostas, não muda as oito vagas ou os 4096 itens da fila, não
altera protocolo, migrações, credenciais ou código de produção.

## O que já existia

Os testes de `WaNodeOrchestrator` verificavam uma consulta bem-sucedida, resposta de ping,
timeout real e com relógio simulado e geração de IDs. A fila tinha testes de capacidade,
concorrência e parâmetros inválidos. A suíte de transporte também cobre diversos sockets
substituídos e handshakes invalidados.

Esses testes isolados não demonstravam que respostas conseguiam liberar consultas enquanto
todas as vagas de tratamento estavam ocupadas. O gate externo tinha dois casos: overflow
com uma retomada, verde, e oito consultas aguardando respostas na mesma fila, vermelho.

## Ampliação de testes

Foram acrescentados 12 testes ao core, cinco ao gate controlado e quatro casos com transporte
local, totalizando 21 cenários novos antes de mudar a implementação.

Os dez testes de correlação cobrem:

- Consulta registrada antes de uma resposta imediata durante o envio.
- Oito respostas entregues aos respectivos solicitantes em ordem invertida.
- ID desconhecido ou ausente preservando a consulta correta.
- Resposta duplicada sem consumir outra consulta.
- ID de envio duplicado sem substituir a consulta já pendente.
- Payload IQ de erro entregue ao solicitante.
- Resposta tardia após timeout sem consumir uma consulta com outro ID.
- Falha de envio e sucesso cancelando o timer antigo antes de reutilizar o ID.
- Cancelamento de todas as consultas, limpeza repetida e timers antigos sem interferir em
  uma consulta nova.

Os dois novos testes da fila verificam liberação de vaga após rejeição e drenagem de oito
trabalhos ativos mais 4096 aguardando, preservando a ordem de início e sem perder trabalhos.

O gate controlado agora tem sete casos:

| Cenário                                                                   | Estado antes da correção |
| ------------------------------------------------------------------------- | ------------------------ |
| Cinco frames excedentes provocam uma retomada                             | Verde                    |
| Sete tratamentos aguardando, respostas em ordem invertida                 | Verde                    |
| Oito tratamentos aguardando respostas                                     | Vermelho                 |
| Oito tratamentos, respostas result/error em ordem invertida               | Vermelho                 |
| IDs desconhecidos, ausentes e duplicados misturados às respostas corretas | Vermelho                 |
| Oito tratamentos e 4096 frames comuns esperando                           | Vermelho                 |
| Uma resposta realmente ausente sem bloquear as outras sete                | Vermelho                 |

Os testes usam relógio simulado para exigir progresso antes do timeout e depois avançam
o tempo para verificar limpeza. Não usam um sleep curto como critério de desempenho. A
retomada é interceptada nesse harness para não abrir rede durante os testes controlados;
esses casos não comprovam reconexão real. As expectativas continuam exigindo o comportamento
desejado, sem converter timeout em sucesso nem marcar os casos vermelhos como skip.

## Ensaio com WebSocket/Noise local

O novo comando `npm run test:upgrade:iq-loopback` usa `WaClient`, registro público de handler,
`lowlevel.query` e `FakeWaServer` em loopback. O transporte, handshake com CA de teste fixada,
criptografia e codec são reais. As notificações e a namespace `w:test` são fixtures sintéticos
da API raw, não representam uma nova funcionalidade do protocolo WhatsApp.

O servidor recebe todas as consultas antes de enviar respostas, depois as devolve em ordem
invertida. As consultas são emitidas de dentro dos handlers das notificações recebidas.

- Sete handlers: todas as consultas concluíram, sem timeout.
- Oito handlers, respostas de sucesso: vermelho.
- Oito handlers, respostas de sucesso/erro: vermelho.
- Sete handlers e receipts retry/enc-rekey com ID de consulta pendente: verde. Os receipts
  passam pelo respectivo handler e não encerram a consulta. Esse contrato deve ser preservado
  por uma futura otimização; procurar qualquer ID pendente sem distinguir esse fluxo seria
  uma mudança de comportamento.

Nas execuções com oito handlers, uma consulta expirou; a vaga liberada permitiu resolver as
outras sete. A conexão permaneceu aberta, com uma autenticação e zero fechamentos durante
o ensaio. No harness com relógio simulado, avançar todos os timers juntos produz oito
timeouts. Os resultados diferem no escalonamento, mas demonstram o mesmo bloqueio inicial.

O ensaio exige todas as consultas concluídas sem timeout. A limpeza deliberada de conexão,
store em memória e servidor ocorre depois das observações. Não usa WhatsApp real nem banco
de produção.

## Cobertura medida antes e depois

A mesma suíte completa do core, com exclusão dos flows, foi executada com `c8` antes e
depois. O recorte de instrumentação contém os quatro arquivos abaixo. Não representa a
cobertura global do repositório nem soma os scripts externos de integração, que usam `dist`.

| Arquivo                 | Linhas antes/depois | Ramos antes/depois |
| ----------------------- | ------------------- | ------------------ |
| `WaNodeOrchestrator.ts` | 81,30% / 94,39%     | 66,66% / 82,69%    |
| `BoundedTaskQueue.ts`   | 90,36% / 98,79%     | 86,66% / 93,54%    |
| `WaComms.ts`            | 65,32% / 65,32%     | 76,00% / 76,00%    |
| `WaNodeTransport.ts`    | 98,86% / 98,86%     | 82,60% / 82,60%    |

Antes: 1374 testes passaram, um skip. Depois: 1386 passaram, um skip, zero falhas.
O gate controlado tem duas aprovações e cinco falhas. O loopback tem duas aprovações e duas
falhas. Os sete vermelhos exercitam variações do bloqueio já conhecido; não demonstram sete
novos defeitos independentes.

Mesmo com 94,39% das linhas do correlacionador cobertas, o teste combinado continua vermelho.
Esse é o motivo para usar contratos de comportamento e integração, além da porcentagem de
cobertura, como critério para a correção.

## Reprodução e próximos critérios

Os testes do core executam TypeScript. Os dois gates externos exigem builds atuais do core
e, para loopback, do fake-server:

```bash
npm run build
npm run build -w packages/fake-server
npm test
npm run test:upgrade:queue
npm run test:upgrade:iq-loopback
```

Os dois últimos comandos retornam erro enquanto o bloqueio estiver aberto. Os testes de
persistência continuam separados em `npm run test:upgrade:persistence`, usando o manifesto
de referência descrito no relatório de credenciais.

A próxima mudança deve tornar os casos vermelhos verdes sem retirar as verificações de
limites, correlação, erros, timers, receipts e manutenção da conexão. Não basta aumentar a
concorrência ou o timeout. A compatibilidade dos hooks/filtros de entrada também deve ser
revisada ao escolher o ponto de reconhecimento antecipado.

Ainda faltam ensaios dirigidos de respostas comprimidas sob saturação e de reconexão durante
consultas com frames antigos já decodificados. A limpeza do correlacionador em memória tem
teste, mas não demonstra sozinha o isolamento completo do transporte durante uma troca.
Validar uma sessão WhatsApp real continua sendo uma etapa separada.
