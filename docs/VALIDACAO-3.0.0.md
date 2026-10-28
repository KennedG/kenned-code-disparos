# Validação — Kenned Code Disparos 3.0.0

Data: 05/10/2026. Ambiente de execução Linux x64, Node.js 24.19, Electron 44.5.1, SQLite nativo e desktop virtual. Integração implementada: Baileys 7.0.0-rc14, não oficial. Não houve acesso a uma conta WhatsApp real nem destinatários de teste reais.

## Resultado dos testes de código

- **534 testes passaram, zero falhas, em 35 arquivos**. Saída integral em `TESTES-3.0.0.txt`.
- **6 fluxos do host desktop** passaram com facade: instância única/IPC/bandeja, eventos de notificações, suspensão/rede/encerramento, manifesto do instalador, identidade com perfil legado e renderizador de áudio/ganho. Isso não valida hardware Windows.
- **7 roteiros na interface Electron** passaram: campanhas/login/permissões; BUSCAS; correções de destinatários/modos/alertas; biblioteca; funções 2.3 (filtros, lembretes, novos contatos, comandos e STOP); comércio; financeiro. Houve fechamento/reabertura real do processo e SQLite persistente. Transporte dessas telas foi simulado e identificado.
- Verificação sintática de `src`, `test` e `scripts` passou.

Cobertura de código: idade original dentro/fora de 2 horas e sua alteração; ranking à vista sem parcelas/entrada; PN/LID privado e própria conta; solicitação sem resultados/modelo; bloqueios de usuário/local; configuração de destinatários e recibos; desconexão, pendência e reconexão; retries limitados e resultado incerto; isolamento real/simulação; mídia referenciada; persistência dos modelos/lembretes; exclusão individual/lote e mídia em uso; contato privado sem duplicações; permissões backend e STOP persistente.

Nova cobertura: multi-categorias/público; acréscimo fixo/percentual e centavos; prévia sem custo/fornecedor; modelo comercial mantém referências de estoque; reserva e sinal; compra/entrada; bloqueio de anúncio de vendido/reservado; demanda compatível incluindo acréscimo; aprovação prepara rascunho sem enviar ao comprador; oportunidade sem alerta repetido; administrador financeiro revalidado; relatórios com versões, sem duplicação, e dados privados restritos.

Financeiro: desconto, taxa, despesa direta, sinal e pagamentos divididos; venda parcial e recebimento posterior; cancelamento, estorno e retorno separados; custo desconhecido e lucro estimado; quantidade/custo de acessórios com alocação exata; recuperação após reinício; duplo clique/idempotência; mesmo identificador com dados diferentes; falha de gravação com rollback; pagamento forjado não vira estorno; saldo após estorno; abertura/fechamento de caixa e proibição de fechamento retroativo inconsistente. Teste de 260 vendas e 520 pagamentos/movimentos verifica tela limitada sem truncar relatórios, índices e isolamento de modos. Vínculos comerciais não são inferidos.

Exemplo conhecido validado também pela interface: custo R$ 2.000; preço R$ 3.500 − desconto R$ 100 = venda R$ 3.400; sinal anterior Pix R$ 500 + dinheiro R$ 900 + crédito R$ 2.000 = recebido R$ 3.400; taxa R$ 60 e despesa direta R$ 40 = líquido R$ 3.300 e lucro R$ 1.300. Caixa inicial R$ 200 + dinheiro R$ 900 − despesa geral R$ 100 = gaveta R$ 1.000. Cartão/Pix não entram na gaveta; sinal não é recebido novamente.

## Causas reproduzidas e corrigidas

1. O formulário comercial consultava 200 ofertas numa API cujo limite é 100: a montagem de listas podia falhar. O limite foi corrigido e erros são exibidos.
2. O seletor comercial podia usar snapshot antigo logo após salvar grupos monitorados. Os formulários atualizam os dados antes de abrir. Uma requisição de atualização em andamento agora agenda uma leitura adicional e compartilha a conclusão, evitando devolver ao formulário os dados anteriores ao salvamento. A troca de modo também limpa os caches dos novos módulos.
3. Pagamentos novos herdavam a hora da venda arredondada pelo campo de minuto; isso podia colocá-los antes da abertura do caixa e rejeitar uma venda válida. Cada recebimento e despesa tem horário próprio; a venda mantém sua data informada.
4. Tipos de entrada/saída manual da interface divergiam do contrato financeiro. A operação agora grava o tipo correto de ajuste e a direção separada.
5. Foram fechadas brechas de validação de pagamentos forjados, saldo após estorno parcial e fechamento de caixa anterior aos movimentos.
6. Modelos e campanhas precisam manter referências confiáveis do estoque. Elas são preservadas no backend; remover metadados no formulário não permite divulgar item vendido.
7. A resolução privada era repetida dentro de `sendPrivate`: autorização/parada verificadas antes da primeira consulta podiam mudar durante a segunda. Alertas, lembretes e comércio agora têm guard síncrono imediatamente antes da submissão. Recusa nesse guard é falha conhecida anterior ao envio, não incerteza fictícia.
8. A última checagem da campanha precisava rever seu próprio horário depois do preparo assíncrono. Agora revalida horário, limite, destino, estoque e STOP. Pausar um grupo omite esse destino sem bloquear os demais elegíveis.
9. Carregar todo o livro de pagamentos em atualizações da tela causaria crescimento de custo. A tela usa janelas de 250 vendas/500 movimentos com consultas indexadas dos pagamentos relacionados; relatórios permanecem completos.

10. No teste do pacote, clicar em consultar relatório durante o salvamento da configuração podia ser ignorado pela trava de operação. Todos os controles financeiros agora sinalizam/aguardam a operação em curso, incluindo controles recriados pela atualização da tela.

11. A expiração persistente das reservas estava disponível no módulo financeiro, mas faltava ligá-la à rotina de segundo plano. A rotina agora registra o vencimento, libera disponibilidade e mantém o sinal para estorno explícito, inclusive com STOP ativo. O fluxo foi testado sem gerar envio.

Os testes do adaptador de produção usam socket autenticado controlado e SQLite real. Comprovam que revogar permissão durante a segunda consulta, STOP, venda durante preparo de mídia e fechamento da janela impedem o request de envio. **Não comprovam recebimento em aparelho real** nem diagnosticar a sessão particular que está no seu computador.

## Distribuição Windows

O instalador NSIS x64, seu payload, fontes congelados, pacote ASAR e ZIP serão verificados por CRC, hashes e cabeçalhos PE. Os sete roteiros Electron também são executados contra o ASAR distribuído usando runtime Electron Linux; isso testa o código empacotado, não executa o `.exe` no Windows. O resultado objetivo da distribuição e hashes acompanham `VALIDACAO-DISTRIBUICAO-3.0.0.json` e `SHA256-3.0.0.txt`.

## Validações externas pendentes

- Conectar conta de teste no Windows e verificar recebimento de `!busca` privado autorizado, comando pela própria conta, ajuda/menu/status/STOP e silêncio para não autorizado.
- Verificar receipt real de alerta de teste e alerta de falha; desconectar/reconectar para aviso pendente com horário original. Confirmar som, volume/mudo, toast/bandeja e políticas do Windows.
- Verificar recebimento real de oportunidade, lembrete e relatório privado somente por administradores autorizados; não usar cliente/grupo de produção como teste.
- Instalar/atualizar fisicamente Windows 10/11 x64, conferir atalhos, inicialização, perfil existente, integridade do backup e retomada após suspensão/reinício.

Nenhum envio real de teste foi feito. Esta entrega contém implementação e artefatos verificáveis, mas a validação ponta a ponta de WhatsApp e Windows físico permanece pendente, sem declaração de produção validada. A API não garante histórico completo de grupos/comunidades, telefone de todo remetente, agenda vinculada nem disponibilidade atual do fornecedor. Consulte `INTEGRACAO.md` e `BUSCAS-INTEGRACAO.md`. Não houve comparação automática de ofertas equivalentes.
