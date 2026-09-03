import defaultMdxComponents from 'fumadocs-ui/mdx';
import { Callout } from 'fumadocs-ui/components/callout';
import type { MDXComponents } from 'mdx/types';
import type { ComponentProps } from 'react';

// use this function to get MDX components, you will need it for rendering MDX
export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    // Keep fumadocs' Callout (icon, title, prose handling) but stamp the
    // Rós Madair red left rule regardless of callout type.
    Callout: (props: ComponentProps<typeof Callout>) => (
      <Callout {...props} className={`az-callout ${props.className ?? ''}`} />
    ),
    ...components,
  };
}
