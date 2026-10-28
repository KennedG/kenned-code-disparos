# Validação da versão 2.3.0

Kenned Code Disparos — validação executada em 05/10/2026, em Linux x64 com Node.js 24 e Electron 44.5.1. O instalador destina-se ao Windows 10/11 x64.

## Resultado e alcance

- `npm run check`: todos os arquivos JavaScript/CJS da fonte, testes e scripts passaram pela verificação de sintaxe.
- `npm test`: **454 testes aprovados em 29 arquivos**, sem falhas, cancelamentos ou testes ignorados, e **6 fluxos da fachada de desktop** aprovados.
- **5 scripts de interface** passaram usando Electron, renderizador, worker e SQLite do aplicativo: painel/campanhas, BUSCAS, correções anteriores, biblioteca e melhorias 2.3.
- A biblioteca Baileys de produção foi importada sem substituição de módulo. Esse teste comprova carregamento das dependências, sem conectar uma conta.

Os testes de transporte utilizam o adaptador de produção com servidor Baileys controlado, ou o modo de simulação explicitamente isolado. Confirmações de servidor/entrega nessas condições são evidência de comportamento do código, não de recebimento num telefone real.

**Recebimento real pelo WhatsApp não foi verificado.** Não havia conta conectada nem número de teste autorizado disponível neste ambiente. Nenhum teste enviou mensagens para clientes, fornecedores ou grupos de produção. Também não havia máquina Windows física para comprovar instalação, bandeja, notificações e áudio no equipamento do usuário.

## Causas encontradas e correções

1. Respostas privadas exigiam nova consulta `onWhatsApp` mesmo quando a integração já tinha recebido uma mensagem autenticada. Falhas nessa consulta e identificadores LID sem resolução de telefone impediam o retorno. A resposta agora usa o chat original com prova assinada, revalidação do remetente e da conta. Números novos configurados continuam exigindo validação; não há troca silenciosa de destino.
2. Identificações factuais de destinatários eram descartadas na reconexão. Agora são preservadas na sessão cifrada, vinculadas à conta e com validade limitada, permitindo retomar avisos pendentes sem inventar identificadores.
3. Destinatários gerais de BUSCAS podiam determinar a resposta de uma consulta privada recebida. Essa consulta responde exclusivamente ao solicitante autorizado; destinatários gerais continuam disponíveis para buscas entregues pelo aplicativo ou comandos nos grupos habilitados. Comandos manuais da própria conta conservam suas opções e verificações específicas.
4. Configurações antigas podiam bloquear comandos privados. Instalações novas habilitam privados para pessoas autorizadas; um bloqueio previamente salvo continua preservado e aparece como aviso em BUSCAS. Habilite essa opção se quiser receber comandos nessa instalação.
5. Modelos dependiam de `window.prompt()`, indisponível no Electron, e a gravação anterior não distinguia criação de edição. O editor nomeia, valida e verifica a persistência de modelos com IDs estáveis, texto, legendas e referências a mídias gerenciadas.
6. A auditoria de comandos tentava gravar uma data ISO numa coluna numérica. A gravação agora usa milissegundos; uma falha na confirmação não gera segunda submissão automática do comando.
7. O cadastro de um contato era persistido, mas a tela mantinha uma lista antiga. O cache da interface agora acompanha o snapshot autenticado; classificar e salvar atualiza imediatamente o cadastro.
8. Parar uma busca aguardando a fila podia rejeitar uma Promise sem tratamento na reconexão/manutenção. O cancelamento comprovadamente anterior à submissão agora conclui com segurança, sem derrubar o worker, criar falso erro de armazenamento ou reiniciar a fila em loop.

## Cobertura funcional

| Fluxo | Evidência executada | Limite da evidência |
|---|---|---|
| BUSCAS: filtros e ordenação | Ofertas dentro/fora de 2 h pela publicação original; minutos/horas/desativação; preço crescente/decrescente/recência; filtros; persistência; preço desconhecido e parcela/entrada fora do ranking; oferta nova substitui antiga | Anúncios controlados, sem comprovação de disponibilidade comercial |
| `!busca` privado | PN e LID resolvidos com identidade confiável; autorizado distinto da conta; resposta exclusivamente ao solicitante; ajuda; ausência de resultados; prefixo; bloqueio por pessoa/local; deduplicação e ecos | Protocolo e ACK controlados; falta telefone real |
| Alertas | Teste pelo mesmo fluxo real do serviço; ocorrência separada da entrega; pendente offline; reconexão; destinatários; aceitação vs entrega; falha temporária, definitiva e incerta; limite de tentativas | Recebimento real e notificação física pendentes |
| Modelos | Criar/nomear, editar, duplicar, excluir, usar em campanha; texto formatado, foto e legenda; salvar pelo editor sem perder rascunho; reabrir banco/aplicativo | Mídias de teste compatíveis; sem envio real |
| LEMBRETES | Diária, dias da semana e data única; fuso Brasília; ocorrência no horário; reinício; atraso descartado ou última ocorrência dentro da tolerância; teste offline/reconexão; pausa e destinatário autorizado; incerto sem repetir | Relógio controlado e transporte de teste |
| Exclusão de mídias | Individual/múltipla, selecionar/desmarcar todos, confirmação EXCLUIR; arquivos vinculados identificam modelos/campanhas/overrides/jobs; rollback e recuperação do arquivo em caso de falha | Bloqueio de arquivo Windows exercitado por erro controlado |
| Seletores de grupos | Os cinco seletores de BUSCAS possuem seleção/desmarcação/contador; pesquisa restringe a ação aos resultados exibidos; modo real vazio sem demonstrações | Listagem de conta real requer conectar |
| Contatos novos | Somente entrada privada verificada; nome factual/telefone/primeiro contato; pendência e notificação únicas; salvar com nome editado e classificação; dispensar; nunca participantes de grupos | Salvo no cadastro local; Baileys não escreve agenda vinculada |
| Administração | `!mega ajuda`, `menu`, `status`, `parar tudo`, `retomar sistema`; permissão central distinta de BUSCAS; comando disponível durante bloqueio; parada persistente de campanhas, buscas, alertas e lembretes; envio em andamento informado | Mensagem administrativa recebida/confirmada em protocolo controlado |
| Backup e dados | Migração esquema 7; isolamento real/simulação; backup de configuração de lembretes restaurada pausada; backup legado preserva lembretes locais; usuários/credenciais/ledgers permanecem locais; permissões antes de diálogo | Arquivo de dados de produção do computador do usuário não estava disponível |

## Reprodução

Para desenvolvimento, use as dependências de `package-lock.json` e execute `npm ci`, `npm run check` e `npm test`. Os cinco scripts de interface são `scripts/smoke-ui.cjs`, `scripts/smoke-searches-ui.cjs`, `scripts/smoke-fixes-ui.cjs`, `scripts/smoke-library-ui.cjs` e `scripts/smoke-230-ui.cjs`; em Linux, precisam de display virtual. Eles usam dados temporários e o modo simulado, nunca contatos de produção. O registro completo está em [TESTES-2.3.0.txt](TESTES-2.3.0.txt).

O instalador é produzido por `npm run dist:win`. A distribuição acompanha hashes SHA-256 e um relatório JSON da verificação de integridade do NSIS, payload, executável PE x64, ASAR e código-fonte. A comparação do pacote com a fonte congelada evita entregar uma compilação anterior.

## Validação que permanece pendente

No Windows de teste, com backup e destinatário autorizado:

1. Instalar a versão 2.3.0, confirmar a preservação do perfil e conectar a conta por QR.
2. Em BUSCAS, habilitar comandos privados, vincular o número particular a um usuário ativo e conceder a autorização explícita de pesquisa. Monitorar somente grupos reais selecionados.
3. Do telefone autorizado, enviar `!busca iPhone 15 Pro Max 256GB`, `!busca` e uma pesquisa sem resultados. Comprovar recebimento no mesmo privado, sem respostas em outros destinos ou duplicadas.
4. Usar **Enviar alerta de teste** e **Testar envio** apenas para números de teste cadastrados. Interromper a conexão; confirmar aviso local e status pendente; reconectar e conferir recebimento mantendo a hora original. Distinguir confirmação de aceitação de recibo de entrega.
5. Testar um lembrete para o número autorizado, reiniciar sem repetir a ocorrência, e executar os comandos administrativos pelo privado. A retomada libera novas filas e exige reativar as campanhas/lembretes desejados.
6. Conferir notificação minimizada na bandeja e som conforme volume/mudo/permissões do Windows. O aplicativo e o computador precisam estar em execução e sem suspensão.

A integração utilizada é Baileys **não oficial**. Comunidades, histórico parcial, PN/LID, edições, exclusões e recibos dependem dos eventos efetivamente fornecidos pelo WhatsApp. Não há garantia de captura completa durante desconexão, nem mecanismo para burlar limites ou bloqueios. Consulte [INTEGRACAO.md](INTEGRACAO.md) e [BUSCAS-INTEGRACAO.md](BUSCAS-INTEGRACAO.md).
