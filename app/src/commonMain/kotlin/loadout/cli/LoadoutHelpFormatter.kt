package loadout.cli

import com.github.ajalt.clikt.core.BaseCliktCommand
import com.github.ajalt.clikt.core.Context
import com.github.ajalt.clikt.output.HelpFormatter
import com.github.ajalt.clikt.output.MordantHelpFormatter
import com.github.ajalt.mordant.rendering.Whitespace
import com.github.ajalt.mordant.rendering.Widget
import com.github.ajalt.mordant.widgets.Text

/**
 * Clikt truncates a subcommand's help to its first line in the root command
 * list. This formatter restores the FULL help there, so the structured
 * arg/flag lines from [commandHelp] show under each command.
 */
class LoadoutHelpFormatter(context: Context) : MordantHelpFormatter(context) {
    /**
     * PRE_WRAP instead of NORMAL: keeps the indentation and column alignment
     * of [commandHelp]'s detail lines (NORMAL collapses all whitespace).
     */
    override fun renderWrappedText(text: String): Widget =
        Text(text.replace("\n\n", "\u0085\u0085"), whitespace = Whitespace.PRE_WRAP)

    override fun renderCommands(
        parameters: List<HelpFormatter.ParameterHelp>,
    ): List<RenderedSection<Widget>> {
        val fullHelp = (context.command as? BaseCliktCommand<*>)
            ?.registeredSubcommands()
            ?.associate { it.commandName to it.help(context) }
            .orEmpty()
        val commands = parameters.filterIsInstance<HelpFormatter.ParameterHelp.Subcommand>().map {
            DefinitionRow(
                styleSubcommandName(it.name),
                renderParameterHelpText(fullHelp[it.name]?.ifBlank { null } ?: it.help, it.tags),
            )
        }
        if (commands.isEmpty()) return emptyList()
        val title = styleSectionTitle(renderSectionTitle(localization.commandsTitle()))
        return listOf(RenderedSection(title, buildParameterList(commands)))
    }
}
