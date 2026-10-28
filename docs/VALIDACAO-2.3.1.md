# Validação — Kenned Code Disparos 2.3.1

Atualização candidata à validação real, produzida exclusivamente a partir da 2.3.0. Sem vendas, caixa, financeiro, custos, margens, relatórios financeiros ou nova comparação automática de ofertas equivalentes.

## Base e preservação

- O ZIP original da 2.3.0 foi conferido por SHA-256: `c36a2812b858025c702e39caeab61307bb0c293d759e97af2d6d0ca6088aea20`; seus 107 arquivos coincidiram com o congelamento original. O trabalho foi feito em outra pasta.
- Esquema SQLite 7 preservado. A primeira abertura de um banco existente nessa atualização cria uma cópia consistente privada e verifica `quick_check` antes das alterações. Falha no backup bloqueia a atualização.
- Testes de recuperação verificaram usuários, hashes/códigos de recuperação, configurações, campanhas, modelos, ofertas e ledgers de confirmação/incerteza. Mídias e sessão exigem também a cópia da pasta integral do perfil.
- Nenhum perfil de produção do usuário estava acessível neste ambiente. Portanto, o backup dos seus dados será criado no seu computador ao atualizar; não foi alegada uma cópia de dados aos quais não tivemos acesso.

## Defeitos comprovados e correções

As causas abaixo foram reproduzidas no código e em testes controlados. Não há logs da conta do usuário que permitam atribuir sua falha específica a uma delas.

1. **Recebimento após decriptação:** um evento sem conteúdo utilizável consumia o identificador. A recuperação posterior do telefone, com `requestId`, também era descartada. Agora somente a recuperação correlacionada à mensagem privada recente já observada pode executar o comando; histórico e eventos repetidos continuam bloqueados.
2. **Telefones antigos formatados:** o remetente era autorizado, mas o número cadastrado com `+55 (62)…` desaparecia da seleção de alertas/listas. A normalização remove apenas pontuação, preservando todos os dígitos; nunca calcula país, nono dígito ou telefone de LID. Os cadastros são preservados.
3. **Provas de conversa após reiniciar:** a 2.3.0 mantinha a chave de assinatura apenas em memória. A chave agora permanece na sessão cifrada pelo Windows; o teste integrado recuperou o Excel pendente para o mesmo LID original. Provas antigas inválidas falham explicitamente e exigem novo comando.
4. **Permissões durante preparação assíncrona:** alterações de telefone, destinatário, conta ou parada geral podiam ocorrer após a validação inicial. Existem verificações finais antes da submissão; o aviso genérico de erro também exige que o número ainda pertença ao solicitante autorizado. Responsáveis vinculados a usuários desativados são recusados.
5. **Diagnóstico e rastreamento:** recusas eram silenciosas ou genéricas, e o transporte criava outro rastreamento para a resposta. Recebimento, autorização, consulta, fila, protocolo, aceitação e recibos posteriores agora compartilham a operação original. Segredos e provas de conversa ficam fora dos logs; etapas informativas não viram erros fictícios.
6. **Recuperação de filas grandes:** apenas os primeiros 500 registros interrompidos eram revisados. A recuperação agora percorre todos; 607 envios interrompidos foram revisados sem repetição automática.
7. **Excel e prévia:** a exportação completa não usa o limite de página ou de 500 candidatos. O novo gerador foi corrigido após o teste Electron detectar rejeição ao funcionar dentro do worker do backend. Todas as partes da prévia são acessíveis antes de confirmar.

## Verificações executadas

- **554 testes automatizados em 39 arquivos: todos passaram**, sem ignorados; verificação de sintaxe também passou.
- **6 fluxos de desktop com fachada nativa**: instância única/IPC/bandeja, retorno de notificações, suspensão/rede/encerramento, manifesto de propriedade, nome novo com perfil legado e renderizador de áudio com volume. Isso não comprova notificações ou alto-falantes físicos no Windows.
- **7 testes de interface Electron no Linux**, com renderizador, worker e SQLite reais e perfis simulados isolados: campanhas; funções da 2.3; alertas/modelos/permissões; biblioteca; BUSCAS; Excel; diagnóstico.
- **Protocolo controlado com o adaptador real:** conta particular distinta da loja, PN/LID, recuperação de decriptação, autorização, resposta ao solicitante, rejeição 403, ACK, entrega posterior, reinício completo, parada geral e bloqueio de usuário desativado. Socket e fachada de proteção do sistema operacional controlados, sem contato com uma conta WhatsApp real.
- **Excel aberto com ExcelJS:** 1.203 linhas no gerador; 603 resultados filtrados no serviço; 121 resultados e 2 selecionados entre páginas na interface. Verificados preços numéricos, telefones como texto, filtros, cabeçalho congelado, fuso original e metadados. A prévia percorreu todas as partes antes de criar a fila.
- **Busca:** ofertas dentro/fora de duas horas, período configurável, ordem, modelo/versão, capacidade, RAM explícita, condição, cor, parcela/entrada/acessório fora do preço total, prefixo, ausência de modelo, ausência de resultados e autorizações.
- **Persistência:** responsáveis/preferências, modelos com mídias, lembretes, controles de repetição, recuperação sem reenvio de confirmado/incerto, backup e proteção de documentos em uso após mais de 500 entregas.
- Os registros externos de distribuição informam a verificação efetiva do ASAR extraído do instalador, integridade NSIS/7z, executável x64 e correspondência entre código congelado, ZIP e pacote. Esses controles não executam uma instalação física no Windows.

## O que permanece pendente

| Etapa | Situação |
|---|---|
| Teste automatizado | Passou |
| Integração simulada / socket controlado | Passou nos cenários descritos |
| Envio aceito por uma conta WhatsApp real | Não testado |
| Entrega confirmada por recibo de WhatsApp real | Não testada |
| Recebimento confirmado no celular particular | Não testado |
| Excel recebido e aberto no WhatsApp do celular | Não testado |
| Instalação, bandeja, notificações e som físicos no Windows 10/11 | Não testados neste ambiente Linux |

Não havia sessão da loja conectada, acesso ao PC do usuário nem número particular de teste identificado. Não foram enviados testes a clientes ou grupos de produção. Não se conclui que o problema real foi resolvido apenas porque os testes passaram.

Para continuar, conecte a conta no aplicativo atualizado e informe somente o número particular de teste com país e DDD, caso ele ainda não esteja identificado. Os comandos exatos e o acompanhamento pelo diagnóstico estão em [Atualização e recuperação](ATUALIZACAO-2.3.1.md). Faça `!mega parar tudo` somente em ambiente controlado, com as campanhas reais previamente pausadas. Confira o rastreamento e confirme separadamente no celular o destino e o recebimento.
