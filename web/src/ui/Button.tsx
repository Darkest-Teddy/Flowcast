import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Link } from 'react-router';
import styles from './Button.module.css';

type Variant = 'primary' | 'accent' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

interface CommonProps {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  children?: ReactNode;
  className?: string;
}

type ButtonProps = CommonProps & ButtonHTMLAttributes<HTMLButtonElement> & { to?: undefined; href?: undefined };
type LinkProps = CommonProps & { to: string; href?: undefined; 'aria-label'?: string };
type AnchorProps = CommonProps & { href: string; to?: undefined; target?: string; rel?: string; 'aria-label'?: string };

/** One button for everything: a <button>, an in-app link (`to`) or an external link (`href`). */
export function Button(props: ButtonProps | LinkProps | AnchorProps) {
  const { variant = 'secondary', size = 'md', icon, children, className } = props;
  const cls = [styles.button, styles[variant], styles[size], className].filter(Boolean).join(' ');
  const inner = (
    <>
      {icon && <span className={styles.icon}>{icon}</span>}
      {children}
    </>
  );

  if ('to' in props && props.to !== undefined) {
    return <Link to={props.to} className={cls} aria-label={props['aria-label']}>{inner}</Link>;
  }
  if ('href' in props && props.href !== undefined) {
    return <a href={props.href} target={props.target} rel={props.rel} className={cls} aria-label={props['aria-label']}>{inner}</a>;
  }
  const { variant: _v, size: _s, icon: _i, className: _c, children: _ch, ...rest } = props as ButtonProps;
  return <button type="button" {...rest} className={cls}>{inner}</button>;
}
